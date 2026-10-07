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
  # Key access stays on because it is the only way to mint the container SAS below: the university
  # Entra tenant has no room for a managed identity (see compute.tf). The account key itself is never
  # given to a server; it lives only in Terraform state (keep that file private).
  shared_access_key_enabled = true

  blob_properties {
    # A stolen upload token must not be able to destroy history: versions and soft-delete keep the
    # previous contents of any blob that is overwritten or deleted.
    versioning_enabled = true
    delete_retention_policy {
      days = 14
    }
    container_delete_retention_policy {
      days = 14
    }
  }

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
      version {
        delete_after_days_since_creation = var.backup_retention_days
      }
    }
  }
}

# What the API VM uses to upload backups (D-03): a SAS limited to this one container. It can read,
# write and list but not delete. `write` also lets a holder overwrite a blob, which is why the account
# keeps blob versions and soft-deletes (above): an overwritten or deleted backup can be recovered.
# It expires on `backup_sas_expiry`; change that date and apply to renew. The value is sensitive and
# is stored in Terraform state, so keep that file private.
data "azurerm_storage_account_blob_container_sas" "backups" {
  connection_string = azurerm_storage_account.backups.primary_connection_string
  container_name    = azurerm_storage_container.backups.name
  https_only        = true

  start  = var.backup_sas_start
  expiry = var.backup_sas_expiry

  permissions {
    read   = true
    add    = true
    create = true
    write  = true
    delete = false
    list   = true
  }
}
