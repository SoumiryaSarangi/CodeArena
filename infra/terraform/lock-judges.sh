#!/usr/bin/env bash
# Phase 2 of the judge bootstrap: take away the judges' temporary public IPs and block their egress.
#
# Two applies, on purpose. Terraform does not know that the NIC must let go of a public IP before the
# IP can be deleted (the NIC no longer mentions it, so no ordering exists), and Azure refuses to
# delete an IP that is still attached. The first apply detaches it (targeted at the NICs), the
# second deletes the IP and finishes the rest. Found in the first real run.
set -euo pipefail
cd "$(dirname "$0")"

echo "Step 1/2: detach the temporary public IPs from the judge network interfaces"
terraform apply -var judge_bootstrap=false -target=azurerm_network_interface.judge

echo
echo "Step 2/2: delete the public IPs and apply the egress lockdown"
terraform apply -var judge_bootstrap=false

echo
terraform output next_steps
