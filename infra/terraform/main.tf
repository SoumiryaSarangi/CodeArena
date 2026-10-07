data "azurerm_client_config" "current" {}

locals {
  name = "${var.project}-${var.environment}"
  tags = merge({ project = var.project, environment = var.environment, managed_by = "terraform" }, var.tags)

  vnet_cidr    = "10.20.0.0/16"
  api_subnet   = "10.20.1.0/24"
  judge_subnet = "10.20.2.0/24"

  # Ports the judges may use on the API VM, and nothing else (ADR-009): Redis for jobs/results and
  # SeaweedFS (S3) for the testsets. Postgres (5432) is deliberately absent: judges hold no database
  # credentials and cannot reach the database.
  judge_to_api_ports = { redis = "6379", s3 = "8333" }
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [local.vnet_cidr]
  tags                = local.tags
}

resource "azurerm_subnet" "api" {
  name                 = "snet-api"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.api_subnet]
}

resource "azurerm_subnet" "judge" {
  name                 = "snet-judge"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.judge_subnet]
  # No implicit internet access: only the temporary public IP (bootstrap) or nothing.
  default_outbound_access_enabled = false
}

# ---------------------------------------------------------------------------------------------
# API subnet firewall
# ---------------------------------------------------------------------------------------------
resource "azurerm_network_security_group" "api" {
  name                = "nsg-${local.name}-api"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

locals {
  api_rules = merge(
    {
      https = { priority = 100, access = "Allow", protocol = "Tcp", port = "443", source = "*" }
      http  = { priority = 110, access = "Allow", protocol = "Tcp", port = "80", source = "*" } # Caddy's certificate challenge and redirect
    },
    { for i, cidr in var.api_ssh_allowed_cidrs : "ssh-${i}" => { priority = 120 + i, access = "Allow", protocol = "Tcp", port = "22", source = cidr } },
    {
      for name, port in local.judge_to_api_ports : "judge-${name}" => {
        priority = 200 + index(keys(local.judge_to_api_ports), name), access = "Allow", protocol = "Tcp", port = port, source = local.judge_subnet
      }
    },
    {
      # The VNet-wide default (AllowVnetInBound) would let a judge reach every port on the API VM.
      # This closes that: everything from the judge subnet that is not allowed above is refused.
      judge-deny-rest = { priority = 300, access = "Deny", protocol = "*", port = "*", source = local.judge_subnet }
    },
  )
}

resource "azurerm_network_security_rule" "api" {
  for_each                    = local.api_rules
  name                        = each.key
  priority                    = each.value.priority
  direction                   = "Inbound"
  access                      = each.value.access
  protocol                    = each.value.protocol
  source_port_range           = "*"
  destination_port_range      = each.value.port
  source_address_prefix       = each.value.source
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.main.name
  network_security_group_name = azurerm_network_security_group.api.name

}

resource "azurerm_subnet_network_security_group_association" "api" {
  subnet_id                 = azurerm_subnet.api.id
  network_security_group_id = azurerm_network_security_group.api.id
}

# ---------------------------------------------------------------------------------------------
# Judge subnet firewall: untrusted code runs here (ADR-009)
# ---------------------------------------------------------------------------------------------
resource "azurerm_network_security_group" "judge" {
  name                = "nsg-${local.name}-judge"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

locals {
  judge_rules = merge(
    {
      # Inbound: SSH from the API VM (jump host) and nothing else, not even from other judges.
      in-ssh-from-api = { direction = "Inbound", priority = 100, access = "Allow", protocol = "Tcp", port = "22", source = local.api_subnet, destination = "*" }
      in-deny-all     = { direction = "Inbound", priority = 200, access = "Deny", protocol = "*", port = "*", source = "*", destination = "*" }

      # Outbound: Redis and object storage on the API subnet, and Azure's own DNS / VM-agent endpoint.
      out-azure-platform = { direction = "Outbound", priority = 100, access = "Allow", protocol = "*", port = "*", source = "*", destination = "168.63.129.16/32" }
      # Everything else inside the VNet (the database, other judges) is refused.
      out-deny-vnet-rest = { direction = "Outbound", priority = 150, access = "Deny", protocol = "*", port = "*", source = "*", destination = "VirtualNetwork" }
    },
    {
      for name, port in local.judge_to_api_ports : "out-${name}-to-api" => {
        direction = "Outbound", priority = 110 + index(keys(local.judge_to_api_ports), name), access = "Allow", protocol = "Tcp", port = port, source = "*", destination = local.api_subnet
      }
    },
    # First apply only: cloud-init needs the internet for packages and the isolate source.
    var.judge_bootstrap ? {
      out-internet-bootstrap = { direction = "Outbound", priority = 200, access = "Allow", protocol = "*", port = "*", source = "*", destination = "Internet" }
    } : {},
    # Steady state: nothing else leaves a judge VM.
    var.judge_bootstrap ? {} : {
      out-deny-all = { direction = "Outbound", priority = 4000, access = "Deny", protocol = "*", port = "*", source = "*", destination = "*" }
    },
  )
}

resource "azurerm_network_security_rule" "judge" {
  for_each                    = local.judge_rules
  name                        = each.key
  priority                    = each.value.priority
  direction                   = each.value.direction
  access                      = each.value.access
  protocol                    = each.value.protocol
  source_port_range           = "*"
  destination_port_range      = each.value.port
  source_address_prefix       = each.value.source
  destination_address_prefix  = each.value.destination
  resource_group_name         = azurerm_resource_group.main.name
  network_security_group_name = azurerm_network_security_group.judge.name
}

resource "azurerm_subnet_network_security_group_association" "judge" {
  subnet_id                 = azurerm_subnet.judge.id
  network_security_group_id = azurerm_network_security_group.judge.id
}
