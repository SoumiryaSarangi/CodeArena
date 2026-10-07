#!/usr/bin/env bash
# Phase 2 of the judge bootstrap: take away the judges' temporary public IPs and block their egress.
#
# Why this is not a plain `terraform apply -var judge_bootstrap=false`: Azure refuses to delete a
# public IP that is still attached to a network interface, and Terraform does not order "update the
# NIC" before "delete the IP" (the NIC no longer mentions it, so no dependency exists; targeting the
# NIC does not help, because the IP is pulled in as its dependency). So the detach is done with the
# Azure CLI first, then Terraform finishes: it sees the NIC already detached, deletes the IP and
# applies the egress lockdown. Found in the first real run.
set -euo pipefail
cd "$(dirname "$0")"

rg="$(terraform output -raw resource_group)"
mapfile -t nics < <(terraform output -json judge_nic_names | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')

echo "Step 1/2: detach the temporary public IPs from the judge network interfaces"
for nic in "${nics[@]}"; do
  attached="$(az network nic ip-config show --resource-group "$rg" --nic-name "$nic" --name primary --query 'publicIPAddress.id' -o tsv 2>/dev/null || true)"
  if [ -n "$attached" ]; then
    echo "  detaching from $nic"
    az network nic ip-config update --resource-group "$rg" --nic-name "$nic" --name primary --remove publicIpAddress --output none
  else
    echo "  $nic: no public IP attached"
  fi
done

echo
echo "Step 2/2: delete the public IPs and apply the egress lockdown"
terraform apply -var judge_bootstrap=false

echo
terraform output next_steps
