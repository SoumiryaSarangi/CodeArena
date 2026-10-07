locals {
  # Ubuntu 24.04 LTS: cgroup v2 by default, which isolate needs (ADR-004).
  image = {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
}

# ---------------------------------------------------------------------------------------------
# API VM: Caddy, API, collab, Postgres, Redis, object storage (Docker Compose, D-02)
# ---------------------------------------------------------------------------------------------
resource "azurerm_public_ip" "api" {
  name                = "pip-${local.name}-api"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "api" {
  name                = "nic-${local.name}-api"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.api.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.api.id
  }
}

resource "azurerm_linux_virtual_machine" "api" {
  name                            = "vm-${local.name}-api"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  size                            = var.api_vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.api.id]
  custom_data                     = base64encode(file("${path.module}/../cloud-init/api.yaml"))
  tags                            = local.tags

  # custom_data (cloud-init) only runs at first boot, and Azure treats a change to it as "replace
  # this VM". Editing the cloud-init files must never rebuild a running server, so changes are
  # ignored here: they apply to VMs created from now on. Changing a running VM is done over SSH by
  # the deploy pipeline (infra/prod), not by cloud-init.
  lifecycle {
    ignore_changes = [custom_data]
  }

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  # No managed identity on purpose: creating one needs an object in the Entra tenant, and the
  # university tenant's directory-object quota is exhausted ("FailedIdentityOperation ... directory
  # object quota limit for the Tenant has been exceeded"). Backups use a container-scoped SAS
  # token instead (storage.tf, D-03).

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = local.image.publisher
    offer     = local.image.offer
    sku       = local.image.sku
    version   = local.image.version
  }
}

# ---------------------------------------------------------------------------------------------
# Judge VMs: run untrusted code (ADR-009). No public IP in steady state.
# ---------------------------------------------------------------------------------------------
resource "azurerm_public_ip" "judge_bootstrap" {
  count               = var.judge_bootstrap ? var.judge_count : 0
  name                = "pip-${local.name}-judge-${count.index}-bootstrap"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "judge" {
  count               = var.judge_count
  name                = "nic-${local.name}-judge-${count.index}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.judge.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = var.judge_bootstrap ? azurerm_public_ip.judge_bootstrap[count.index].id : null
  }
}

resource "azurerm_linux_virtual_machine" "judge" {
  count                           = var.judge_count
  name                            = "vm-${local.name}-judge-${count.index}"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  size                            = var.judge_vm_size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.judge[count.index].id]
  custom_data                     = base64encode(file("${path.module}/../cloud-init/judge.yaml"))
  tags                            = merge(local.tags, { role = "judge" })

  # custom_data (cloud-init) only runs at first boot, and Azure treats a change to it as "replace
  # this VM". Editing the cloud-init files must never rebuild a running server, so changes are
  # ignored here: they apply to VMs created from now on. Changing a running VM is done over SSH by
  # the deploy pipeline (infra/prod), not by cloud-init.
  lifecycle {
    ignore_changes = [custom_data]
  }

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  # No managed identity: a compromised judge must have nothing to ask Azure for.

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 32
  }

  source_image_reference {
    publisher = local.image.publisher
    offer     = local.image.offer
    sku       = local.image.sku
    version   = local.image.version
  }
}
