# The key below is a throwaway generated for these tests (public half only, used nowhere).
# Offline tests (no Azure account needed): `terraform test`.
# They plan against a mock provider and assert the security claims ADR-009 and D-01 make, so a
# careless edit to a firewall rule fails here instead of in production.

mock_provider "azurerm" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKDvqKE1za/L6JIx9X9CRBghobMZfAaH455pWZvjuxjy test@example"
}

# ---------------------------------------------------------------------------------------------
run "steady_state_judge_is_locked_down" {
  command = plan

  variables {
    judge_bootstrap = false
  }

  assert {
    condition     = length(azurerm_public_ip.judge_bootstrap) == 0
    error_message = "A locked-down judge must have no public IP."
  }

  assert {
    condition     = alltrue([for n in azurerm_network_interface.judge : n.ip_configuration[0].public_ip_address_id == null])
    error_message = "Judge NICs must not reference a public IP."
  }

  assert {
    condition = (
      azurerm_network_security_rule.judge["out-deny-all"].access == "Deny" &&
      azurerm_network_security_rule.judge["out-deny-all"].direction == "Outbound" &&
      azurerm_network_security_rule.judge["out-deny-all"].destination_address_prefix == "*"
    )
    error_message = "The catch-all outbound deny must exist when the judge is locked down."
  }

  assert {
    condition     = !contains(keys(azurerm_network_security_rule.judge), "out-internet-bootstrap")
    error_message = "The internet-egress allow must not exist in steady state."
  }

  # Everything a judge may send out: only Redis/S3 on the API subnet and Azure's platform address.
  assert {
    condition = alltrue([
      for r in values(azurerm_network_security_rule.judge) :
      r.direction != "Outbound" || r.access != "Allow" || contains(["10.20.1.0/24", "168.63.129.16/32"], r.destination_address_prefix)
    ])
    error_message = "A judge may only send traffic to the API subnet and the Azure platform address."
  }

  assert {
    condition = alltrue([
      for r in values(azurerm_network_security_rule.judge) :
      r.direction != "Outbound" || r.access != "Allow" || r.destination_address_prefix != "10.20.1.0/24" || contains(["6379", "8333"], r.destination_port_range)
    ])
    error_message = "Towards the API subnet a judge may only use Redis (6379) and object storage (8333)."
  }
}

# ---------------------------------------------------------------------------------------------
run "bootstrap_gives_the_judge_a_temporary_way_out" {
  command = plan

  variables {
    judge_bootstrap = true
    judge_count     = 2
  }

  # The id of a public IP is only known after apply; give the mock one so the NIC wiring can be checked.
  override_resource {
    target          = azurerm_public_ip.judge_bootstrap
    override_during = plan
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip"
    }
  }

  assert {
    condition     = length(azurerm_public_ip.judge_bootstrap) == 2
    error_message = "Bootstrap mode needs one temporary public IP per judge."
  }

  assert {
    condition     = alltrue([for n in azurerm_network_interface.judge : n.ip_configuration[0].public_ip_address_id != null])
    error_message = "Bootstrap judges must have their temporary public IP attached."
  }

  assert {
    condition     = azurerm_network_security_rule.judge["out-internet-bootstrap"].destination_address_prefix == "Internet"
    error_message = "Bootstrap mode must allow internet egress."
  }

  assert {
    condition     = !contains(keys(azurerm_network_security_rule.judge), "out-deny-all")
    error_message = "The catch-all deny must be absent while bootstrapping."
  }

  # Even while bootstrapping, a judge cannot reach the database or anything else inside the VNet.
  assert {
    condition     = azurerm_network_security_rule.judge["out-deny-vnet-rest"].access == "Deny" && azurerm_network_security_rule.judge["out-deny-vnet-rest"].destination_address_prefix == "VirtualNetwork"
    error_message = "VNet-internal traffic other than Redis/S3 must stay denied during bootstrap."
  }
}

# ---------------------------------------------------------------------------------------------
run "nothing_reaches_a_judge_from_the_internet" {
  command = plan

  assert {
    condition = alltrue([
      for r in values(azurerm_network_security_rule.judge) :
      r.direction != "Inbound" || r.access != "Allow" || r.source_address_prefix == "10.20.1.0/24"
    ])
    error_message = "The only inbound allow on the judge subnet may come from the API subnet."
  }

  assert {
    condition     = azurerm_network_security_rule.judge["in-ssh-from-api"].destination_port_range == "22"
    error_message = "SSH from the API VM (jump host) is the one inbound path to a judge."
  }

  assert {
    condition     = azurerm_network_security_rule.judge["in-deny-all"].access == "Deny" && azurerm_network_security_rule.judge["in-deny-all"].source_address_prefix == "*"
    error_message = "Everything else inbound to a judge must be denied (including from other judges)."
  }

  assert {
    condition     = alltrue([for v in azurerm_linux_virtual_machine.judge : length(v.identity) == 0])
    error_message = "A judge VM must have no managed identity: it must have nothing to ask Azure for."
  }
}

# ---------------------------------------------------------------------------------------------
run "judges_cannot_reach_the_database_or_anything_else_on_the_api_vm" {
  command = plan

  # What the API subnet lets in from the judge subnet.
  assert {
    condition = join(",", sort([
      for r in values(azurerm_network_security_rule.api) :
      r.destination_port_range if r.source_address_prefix == "10.20.2.0/24" && r.access == "Allow"
    ])) == "6379,8333"
    error_message = "From the judge subnet the API VM must accept only Redis (6379) and object storage (8333)."
  }

  assert {
    condition     = azurerm_network_security_rule.api["judge-deny-rest"].access == "Deny" && azurerm_network_security_rule.api["judge-deny-rest"].source_address_prefix == "10.20.2.0/24" && azurerm_network_security_rule.api["judge-deny-rest"].destination_port_range == "*"
    error_message = "Everything else from the judge subnet must be denied (Postgres 5432 included)."
  }

  # The deny must be evaluated after the two allows (lower number first).
  assert {
    condition = (
      azurerm_network_security_rule.api["judge-deny-rest"].priority > azurerm_network_security_rule.api["judge-redis"].priority &&
      azurerm_network_security_rule.api["judge-deny-rest"].priority > azurerm_network_security_rule.api["judge-s3"].priority
    )
    error_message = "The judge deny rule must come after the Redis and S3 allows."
  }

  assert {
    condition     = !contains([for r in values(azurerm_network_security_rule.api) : r.destination_port_range if r.access == "Allow"], "5432")
    error_message = "Postgres must not be open to anyone."
  }
}

# ---------------------------------------------------------------------------------------------
run "api_vm_is_reachable_the_way_we_decided" {
  command = plan

  assert {
    condition     = join(",", sort([for r in values(azurerm_network_security_rule.api) : r.destination_port_range if r.access == "Allow" && r.source_address_prefix == "*"])) == "22,443,80"
    error_message = "From the internet the API VM accepts only 80, 443 and (key-only) SSH."
  }

  assert {
    condition     = azurerm_linux_virtual_machine.api.disable_password_authentication == true
    error_message = "Password login must be off on the API VM."
  }

  assert {
    condition     = azurerm_public_ip.api.allocation_method == "Static" && azurerm_public_ip.api.sku == "Standard"
    error_message = "The API VM needs a static public IP."
  }

  assert {
    condition     = azurerm_linux_virtual_machine.api.identity[0].type == "SystemAssigned"
    error_message = "The API VM needs an identity to upload backups without a stored secret."
  }
}

run "ssh_can_be_restricted_to_chosen_addresses" {
  command = plan

  variables {
    api_ssh_allowed_cidrs = ["203.0.113.7/32", "198.51.100.0/24"]
  }

  assert {
    condition     = azurerm_network_security_rule.api["ssh-0"].source_address_prefix == "203.0.113.7/32" && azurerm_network_security_rule.api["ssh-1"].source_address_prefix == "198.51.100.0/24"
    error_message = "SSH must follow api_ssh_allowed_cidrs."
  }

  assert {
    condition     = !contains(keys(azurerm_network_security_rule.api), "ssh-2")
    error_message = "No extra SSH rule."
  }
}

# ---------------------------------------------------------------------------------------------
run "judge_count_scales_vms" {
  command = plan

  variables {
    judge_count   = 3
    judge_vm_size = "Standard_D2s_v5"
  }

  assert {
    condition     = length(azurerm_linux_virtual_machine.judge) == 3 && length(azurerm_network_interface.judge) == 3
    error_message = "judge_count must create that many VMs and NICs."
  }

  assert {
    condition     = alltrue([for v in azurerm_linux_virtual_machine.judge : v.size == "Standard_D2s_v5" && v.disable_password_authentication])
    error_message = "judge_vm_size must apply to every judge, and password login must be off."
  }
}

run "judge_count_zero_is_allowed" {
  command = plan

  variables {
    judge_count = 0
  }

  assert {
    condition     = length(azurerm_linux_virtual_machine.judge) == 0
    error_message = "judge_count = 0 must create no judge VMs."
  }
}

run "judge_count_is_validated" {
  command = plan

  variables {
    judge_count = 11
  }

  expect_failures = [var.judge_count]
}

# ---------------------------------------------------------------------------------------------
run "backups_are_private_and_expire" {
  command = plan

  assert {
    condition = (
      azurerm_storage_account.backups.allow_nested_items_to_be_public == false &&
      azurerm_storage_account.backups.shared_access_key_enabled == false &&
      azurerm_storage_account.backups.min_tls_version == "TLS1_2" &&
      azurerm_storage_account.backups.https_traffic_only_enabled == true
    )
    error_message = "The backup account must be private, key-less, TLS 1.2 and HTTPS only."
  }

  assert {
    condition     = azurerm_storage_container.backups.container_access_type == "private"
    error_message = "The backups container must be private."
  }

  assert {
    condition     = azurerm_storage_management_policy.backups.rule[0].actions[0].base_blob[0].delete_after_days_since_modification_greater_than == 30
    error_message = "Backups must expire after 30 days by default."
  }

  assert {
    condition     = azurerm_role_assignment.api_backups.role_definition_name == "Storage Blob Data Contributor"
    error_message = "The API VM identity needs write access to the backups container."
  }

  assert {
    condition     = can(regex("^st[a-z0-9]{3,22}$", azurerm_storage_account.backups.name)) && length(azurerm_storage_account.backups.name) <= 24
    error_message = "The storage account name must be a valid, globally unique-looking name (3-24 lowercase letters and digits)."
  }
}

# ---------------------------------------------------------------------------------------------
run "budget_alerts_at_25_50_75_percent" {
  command = plan

  assert {
    condition     = toset([for n in azurerm_consumption_budget_resource_group.main[0].notification : n.threshold]) == toset([25, 50, 75])
    error_message = "Budget alerts must fire at 25, 50 and 75 percent."
  }

  assert {
    condition     = azurerm_consumption_budget_resource_group.main[0].amount == 100
    error_message = "The default budget is the 100 USD credit."
  }
}

run "budget_can_be_turned_off" {
  command = plan

  variables {
    create_budget = false
  }

  assert {
    condition     = length(azurerm_consumption_budget_resource_group.main) == 0
    error_message = "create_budget = false must create no budget."
  }
}

# ---------------------------------------------------------------------------------------------
run "bad_ssh_key_is_rejected" {
  command = plan

  variables {
    ssh_public_key = "not a key"
  }

  expect_failures = [var.ssh_public_key]
}
