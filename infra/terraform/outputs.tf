output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "api_public_ip" {
  description = "Static address of the API VM (point DNS here, or use the sslip.io name below)."
  value       = azurerm_public_ip.api.ip_address
}

output "api_host_sslip" {
  description = "A working HTTPS host name before a real domain exists: Caddy gets a certificate for it automatically."
  value       = "api.${replace(azurerm_public_ip.api.ip_address, ".", "-")}.sslip.io"
}

output "api_private_ip" {
  description = "What the judges use for Redis and object storage."
  value       = azurerm_network_interface.api.private_ip_address
}

output "judge_private_ips" {
  value = azurerm_network_interface.judge[*].private_ip_address
}

output "judge_bootstrap_public_ips" {
  description = "Temporary: only present while judge_bootstrap = true."
  value       = azurerm_public_ip.judge_bootstrap[*].ip_address
}

output "backup_storage_account" {
  value = azurerm_storage_account.backups.name
}

output "backup_container" {
  value = azurerm_storage_container.backups.name
}

output "backup_container_sas" {
  description = "Upload token for the backups container (read/write/list, no delete). Sensitive: show with `terraform output -raw backup_container_sas`. D-03 puts it on the API VM."
  value       = data.azurerm_storage_account_blob_container_sas.backups.sas
  sensitive   = true
}

output "ssh" {
  description = "How to log in. Judges have no public address: jump through the API VM."
  value = {
    api    = "ssh ${var.admin_username}@${azurerm_public_ip.api.ip_address}"
    judges = [for ip in azurerm_network_interface.judge[*].private_ip_address : "ssh -J ${var.admin_username}@${azurerm_public_ip.api.ip_address} ${var.admin_username}@${ip}"]
  }
}

output "next_steps" {
  value = var.judge_bootstrap ? "Judge VMs are in BOOTSTRAP mode (public IP, open egress). When cloud-init has finished on each (ssh in, run: cloud-init status --wait), run: terraform apply -var judge_bootstrap=false" : "Judge VMs are locked down (no public IP; egress only to Redis and object storage on the API subnet)."
}
