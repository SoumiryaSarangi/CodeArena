variable "subscription_id" {
  description = "Azure subscription id: `az account show --query id -o tsv`."
  type        = string
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "codearena"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,15}$", var.project))
    error_message = "Use 3-16 lowercase letters and digits, starting with a letter (it is part of the storage account name)."
  }
}

variable "environment" {
  description = "Environment name (prod is the only one: PLAN §5.2)."
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Azure region. Central India if the subscription allows it (PLAN §5.1); otherwise the nearest allowed one (see README)."
  type        = string
  default     = "centralindia"
}

variable "admin_username" {
  description = "Linux user on every VM. Login is by SSH key only."
  type        = string
  default     = "codearena"
}

variable "ssh_public_key" {
  description = "Your SSH public key (the contents of ~/.ssh/id_ed25519.pub). Password login is disabled."
  type        = string
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) ", var.ssh_public_key))
    error_message = "That does not look like an SSH public key (it should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-)."
  }
}

variable "api_ssh_allowed_cidrs" {
  description = "Who may reach SSH (port 22) on the API VM. Open to the internet by default so GitHub Actions can deploy (D-02); login is key-only. Judge VMs are only reachable through this VM."
  type        = list(string)
  default     = ["*"]
}

variable "api_vm_size" {
  description = "API VM (Caddy, API, Postgres, Redis, object storage, collab). 2 vCPU / 4 GB."
  type        = string
  default     = "Standard_B2s"
}

variable "judge_vm_size" {
  description = "Judge VM size. B2s is burstable: under sustained judging its CPU credits run out and it is throttled, which skews timings. Use Standard_D2s_v5 (non-burstable) for the load test and contest day."
  type        = string
  default     = "Standard_B2s"
}

variable "judge_count" {
  description = "Number of judge VMs: 1 in steady state, 3 for the load test and contest day (U8.1)."
  type        = number
  default     = 1
  validation {
    condition     = var.judge_count >= 0 && var.judge_count <= 10 && floor(var.judge_count) == var.judge_count
    error_message = "judge_count must be a whole number from 0 to 10."
  }
}

variable "judge_bootstrap" {
  description = <<-EOT
    true  = judge VMs get a temporary public IP and can reach the internet, so cloud-init can install
            packages and build isolate (first apply, or a maintenance window).
    false = no public IP, and egress is limited to Redis and object storage on the API subnet
            (steady state; run `terraform apply -var judge_bootstrap=false` once cloud-init is done).
  EOT
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Backups older than this are deleted automatically."
  type        = number
  default     = 30
}

variable "create_budget" {
  description = "Create the cost budget with alerts at 25/50/75 %. Set false if the subscription (Azure for Students) rejects Cost Management budgets."
  type        = bool
  default     = true
}

variable "budget_amount" {
  description = "Budget in USD for the whole period."
  type        = number
  default     = 100
}

variable "budget_start_date" {
  description = "First day of a month, RFC 3339 (Azure requires the 1st)."
  type        = string
  default     = "2026-10-01T00:00:00Z"
}

variable "budget_end_date" {
  description = "End of the budget period, RFC 3339."
  type        = string
  default     = "2027-09-30T00:00:00Z"
}

variable "budget_alert_emails" {
  description = "Extra e-mail addresses for budget alerts (subscription Owners are always notified)."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = {}
}
