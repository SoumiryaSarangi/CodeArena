locals {
  # Globally unique, 3-24 lowercase letters and digits, stable for a subscription.
  storage_name = substr("st${var.project}${substr(sha256("${data.azurerm_client_config.current.subscription_id}/${local.name}"), 0, 10)}", 0, 24)
}

resource "azurerm_storage_account" "backups" {
  name                     = local.storage_name
  location                 = azurerm_resource_group.main.location
  resource_group_name      = azurerm_resource_group.main.name
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"

  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  # Access is by Azure AD identity only: there is no account key to leak.
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  tags = local.tags
}

resource "azurerm_storage_container" "backups" {
  name                  = "backups"
  storage_account_id    = azurerm_storage_account.backups.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "backups" {
  storage_account_id = azurerm_storage_account.backups.id

  rule {
    name    = "expire-old-backups"
    enabled = true
    filters {
      prefix_match = ["backups/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.backup_retention_days
      }
    }
  }
}

# The API VM's identity may write backups to this container and nothing else in the account.
resource "azurerm_role_assignment" "api_backups" {
  scope                = azurerm_storage_container.backups.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_virtual_machine.api.identity[0].principal_id
}
