# Alerts at 25 / 50 / 75 % of the budget (PLAN §5.1). Azure for Students may not offer Cost
# Management budgets: if apply fails on this resource, set create_budget = false.
resource "azurerm_consumption_budget_resource_group" "main" {
  count             = var.create_budget ? 1 : 0
  name              = "budget-${local.name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.budget_amount
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
    end_date   = var.budget_end_date
  }

  dynamic "notification" {
    for_each = [25, 50, 75]
    content {
      enabled        = true
      threshold      = notification.value
      threshold_type = "Actual"
      operator       = "GreaterThan"
      contact_emails = var.budget_alert_emails
      contact_roles  = ["Owner"]
    }
  }
}
