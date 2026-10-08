# Azure infrastructure (D-01)

Everything the deployment needs on Azure, as code: network, firewalls, the API VM, the judge VM(s),
a private Blob container for backups, and a cost budget. **Nothing exists until you run
`terraform apply`.** (Claude writes this and tests it offline; creating cloud resources is yours.)

```
Internet ──80/443/22──▶ API VM (Caddy, API, Postgres, Redis, object storage)   snet-api   10.20.1.0/24
                           ▲  only Redis 6379 + object storage 8333, nothing else
                           │
                        Judge VM(s): worker + isolate (run untrusted code)     snet-judge 10.20.2.0/24
                           no public IP · no inbound except SSH from the API VM · egress only to the two ports above
```

## What you need

- An Azure subscription (Azure for Students), and in WSL: `az` (Azure CLI) and `terraform` ≥ 1.7.
- An SSH key pair (`ssh-keygen -t ed25519` if you have none).

## Steps

1. **Log in and pick the subscription**
   ```
   az login
   az account show --query "{name:name, id:id}" -o table
   ```
2. **Check the region and sizes your subscription allows.** Azure for Students has a policy that
   limits regions and hides some VM sizes, and it differs per account. List the allowed regions,
   then check the sizes in them:
   ```
   az policy assignment list --query "[].{name:displayName, regions:parameters.listOfAllowedLocations.value}" -o json
   az vm list-skus --location eastasia --resource-type virtualMachines --query "[?length(restrictions)==\`0\` && contains(['Standard_B2s_v2','Standard_D2s_v5'], name)].name" -o tsv
   ```
   For the account this was written for, only `eastasia`, `malaysiawest`, `polandcentral`,
   `koreacentral` and `uaenorth` are allowed, and `eastasia` is the one with the sizes we need
   (`Standard_B2s_v2`, and `Standard_D2s_v5` for contests), so those are the defaults. If your
   account differs, set `location` / `api_vm_size` / `judge_vm_size` in `terraform.tfvars`. Make
   sure the providers are registered once:
   ```
   for ns in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.Consumption Microsoft.Authorization; do az provider register --namespace $ns; done
   ```
3. **Configure**
   ```
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in subscription_id and ssh_public_key
   ```
4. **Plan, and read it** (U5.1: paste the output to Claude before applying)
   ```
   terraform init
   terraform plan
   ```
   You should see about 31 resources to add: a resource group, VNet and two subnets, two NSGs with
   their rules, a public IP and NIC for the API VM, the API VM, one judge NIC + VM + temporary
   public IP, a storage account + container + lifecycle policy, and the budget.
5. **Apply**
   ```
   terraform apply
   terraform output
   ```
6. **Wait for the judge to finish setting itself up**, then lock it down. The judge VM builds isolate
   on first boot, which needs the internet, so the first apply gives it a _temporary_ public IP and
   open egress (`judge_bootstrap = true`).
   ```
   # use the commands printed by `terraform output ssh`
   ssh -J codearena@<api-ip> codearena@<judge-private-ip> 'cloud-init status --wait'
   ./lock-judges.sh
   ```
   The script first detaches the judge's temporary public IP with the Azure CLI (Azure will not
   delete an IP that is still attached, and Terraform does not order those two steps by itself, even
   with `-target`), then runs `terraform apply -var judge_bootstrap=false`, which deletes the IP and
   adds the rule that blocks all other egress. Type `yes` at the prompt. Check:
   ```
   ssh -J codearena@<api-ip> codearena@<judge-private-ip> 'curl -m 5 -sI https://example.com >/dev/null 2>&1 && echo "INTERNET OPEN (bad)" || echo "no internet (good)"'
   ```
   You can still reach the judge through the API VM (jump host).
7. **Domain** (U5.3): until the `.me` domain exists, use the `api_host_sslip` output
   (`api.<ip-with-dashes>.sslip.io`): Caddy gets a certificate for it automatically (D-02).

## Day-to-day

| Task                                 | Command                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Load test / contest day: more judges | `scripts/scale-judges.sh up 1` (2 judges is the most this subscription's quota allows; wraps apply, wait, lock, register, install the worker) |
| Back to steady state                 | `scripts/scale-judges.sh to 1` (writes `judges.auto.tfvars`, which a plain `terraform apply` then keeps)                                      |
| Patch a locked-down judge            | `terraform apply -var judge_bootstrap=true`, do the update, then `-var judge_bootstrap=false`                                                 |
| Tear everything down                 | `terraform destroy` (the backups go with it: download them first)                                                                             |
| Offline tests of the firewall rules  | `terraform test` (no Azure account needed)                                                                                                    |

**Why D2s_v5 for contests.** `Standard_B2s` is _burstable_: it earns CPU credits while idle and is
throttled to a baseline once they run out. Sustained judging drains them, which makes timings
unfair (flaky TLEs). `Standard_D2s_v5` is not burstable. B-series is fine for the quiet days.

## Cost (rough, check the Azure pricing calculator for your region)

| Item                                                                                 | Rate          | Steady state, 10 days |
| ------------------------------------------------------------------------------------ | ------------- | --------------------- |
| API VM B2s                                                                           | ~$0.04/h      | ~$10                  |
| Judge VM B2s (1)                                                                     | ~$0.04/h      | ~$10                  |
| Judge VM D2s_v5, contest day only (3 × ~8 h)                                         | ~$0.10/h each | ~$3                   |
| Disks, public IP, storage                                                            | a few $/month | ~$3                   |
| Well inside the $100 credit. Budget alerts at 25/50/75 % are created by `budget.tf`. |

## State file: back it up

Terraform remembers what it created in `terraform.tfstate` (local, gitignored). If you lose it,
Terraform no longer knows about the resources (they keep running and costing money). Copy the file
somewhere safe after every apply.

## If something fails

- _"directory object quota limit for the Tenant has been exceeded"_ when creating a VM: the VM asked for a managed identity, and the university's Entra directory cannot hold more objects. This module therefore gives no VM an identity (backups use a container-scoped upload token instead, see `backup_container_sas`). If you ever add an identity and hit this, that is why.
- Do **not** use `-var create_budget=false` unless the budget resource itself fails: it deletes an existing budget.

- _"budget ... not supported"_ (Azure for Students): set `create_budget = false`. U0.2 already made one in the portal.
- _"SkuNotAvailable" / "not allowed in this region"_: pick another size or region (step 2).
- _"AuthorizationFailed" on the role assignment_: your login needs Owner on the subscription (Students accounts have it).

## Explain-back (U5.5)

**Why do judge VMs hold no database credentials?** They run code written by strangers. If a sandbox
were ever escaped, the attacker would be on the judge VM and nowhere else: no Postgres password to
steal, no network path to Postgres, no Azure identity to ask for tokens. All a judge can do is what
its Redis user allows (read jobs, post results) and read tests from object storage (ADR-009).

**What does the network security group block?** On the judge subnet: all inbound except SSH from the
API VM; all outbound except Redis (6379) and object storage (8333) on the API subnet and Azure's
DNS/agent address; in steady state no internet at all, and no public IP. On the API subnet: the judge
subnet may reach only those two ports, so Postgres (5432) and everything else on the API VM is
refused, even though the default Azure rules would have allowed it. The sandbox's own isolation (no
network inside a box) is a second layer under this one.

## Backups: the upload token

There is no Azure identity for the API VM (see above), so D-03 uploads with a **SAS token limited to
the `backups` container**: it can read, write and list, never delete, it expires on
`backup_sas_expiry` (default 2027-04-07), and the account keeps blob versions and soft-deleted blobs
for 14 days, so an overwritten or deleted backup is recoverable. Show it with
`terraform output -raw backup_container_sas`. The token and the storage account key are stored in
`terraform.tfstate`: keep that file private (it is gitignored), and never paste the token anywhere
public.
