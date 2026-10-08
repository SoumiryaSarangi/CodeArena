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
  description = "Azure region. PLAN §5.1 prefers Central India, but the Azure for Students policy here only allows eastasia, malaysiawest, polandcentral, koreacentral and uaenorth, and only eastasia has the VM sizes below (checked with az vm list-skus)."
  type        = string
  default     = "eastasia"
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
  description = "API VM (Caddy, API, Postgres, Redis, object storage, collab). Standard_B2s_v2 = 2 vCPU / 8 GB, burstable (the old Standard_B2s is not offered in the allowed region)."
  type        = string
  default     = "Standard_B2s_v2"
}

variable "judge_vm_size" {
  description = "Judge VM size. B-series is burstable: under sustained judging its CPU credits run out and it is throttled, which skews timings. Use Standard_D2s_v5 (non-burstable, available in eastasia) for the load test and contest day."
  type        = string
  default     = "Standard_B2s_v2"
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

variable "judge_bootstrap_from" {
  description = <<-EOT
    Only with judge_bootstrap = true: the index of the first judge that still needs the temporary
    public IP. Judges below it are already set up and keep no public IP, so adding judges to a running
    fleet gives IPs to the new ones only. Azure for Students allows 3 public IPs per region and the API
    VM uses one, so at most 2 judges can be bootstrapped at a time (a plan with more is refused).
    scripts/scale-judges.sh sets this; the first apply leaves it at 0.
  EOT
  type        = number
  default     = 0
  validation {
    condition     = var.judge_bootstrap_from >= 0 && floor(var.judge_bootstrap_from) == var.judge_bootstrap_from
    error_message = "judge_bootstrap_from must be a whole number, 0 or more."
  }
}

variable "backup_retention_days" {
  description = "Backups older than this are deleted automatically."
  type        = number
  default     = 30
}

variable "backup_sas_start" {
  description = "When the backup upload token becomes valid (RFC 3339, UTC). Fixed, not `timestamp()`, so plans stay stable."
  type        = string
  default     = "2026-10-07T00:00:00Z"
}

variable "backup_sas_expiry" {
  description = "When the backup upload token stops working. Renew by changing this and applying."
  type        = string
  default     = "2027-04-07T00:00:00Z"
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
