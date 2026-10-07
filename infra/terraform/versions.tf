terraform {
  required_version = ">= 1.7.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  # Blob containers are managed through the Azure Resource Manager API (no storage keys), because
  # shared-key access is switched off on the backup account.
  storage_use_azuread = true
}
