# Spec: Node.js Docker App on AWS EC2 and AWS Fargate

This document describes how one small Node.js app is packaged with Docker and deployed to AWS in two different ways:

1. **EC2**: a virtual machine that we manage ourselves.
2. **Fargate**: serverless containers on ECS, with no machine to manage.

Both deployments keep the files the app creates in a **persistent volume**, so the files survive when the container is replaced. Both are deployed automatically by **GitHub Actions** and built with **Terraform**.

---

## 1. The Application

| Item | Value |
|---|---|
| Language | Node.js 20 (built-in modules only, no npm packages) |
| Container port | `3000` |
| Data folder inside the container | `/app/data` |
| Version shown on the page | `APP_VERSION` environment variable (set to the git commit SHA by the pipeline) |

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Web UI: container card, volume card, file table |
| GET | `/health` | Returns `OK`. Used by health checks |
| GET | `/create` | Creates a file in `/app/data` (plain text response) |
| GET | `/files` | Lists file names (plain text) |
| GET | `/api/info` | Container ID, start time, version, data folder, file count |
| GET / POST / DELETE | `/api/files` | List, create, or delete all files |

### How the UI proves the volume works

Every file records which container created it. After a new deployment, the container ID changes, but older files are still listed with an **"older container"** badge. That shows the data lives outside the container.

---

## 2. Repository Layout

```
NODE-APP-DOCKER-EC2-FARGATE/
├── app/
│   ├── server.js
│   └── Dockerfile
├── terraform/
│   ├── ec2/
│   │   ├── providers.tf
│   │   ├── variables.tf
│   │   ├── main.tf
│   │   ├── github.tf
│   │   └── outputs.tf
│   └── fargate/
│       ├── providers.tf
│       ├── variables.tf
│       ├── main.tf
│       ├── github.tf
│       └── outputs.tf
├── .github/workflows/
│   ├── deploy-ec2.yml
│   └── deploy-fargate.yml
├── .gitignore
└── Spec.md
```

---

## 3. Shared Foundations (used by both)

These pieces were created once, by hand, before either deployment.

| Item | Example value | Purpose |
|---|---|---|
| AWS region | `ap-south-1` (Mumbai) | Where everything runs |
| Terraform state bucket | `my-tf-state-bucket-ui-static-page-practice` | Stores Terraform state. EC2 uses key `ec2/terraform.tfstate`, Fargate uses `fargate/terraform.tfstate` |
| GitHub OIDC identity provider | `token.actions.githubusercontent.com` | Lets GitHub Actions log in to AWS without stored keys |
| Default VPC and subnets | Provided by AWS | Network for both deployments. No custom VPC is created |

### How GitHub Actions logs in to AWS (OIDC)

No AWS access keys are stored anywhere. Each workflow run asks GitHub for a short-lived token, and AWS exchanges it for temporary credentials **only if** the token comes from this repository.

The trust policy accepts both formats GitHub may send in the `sub` claim:

```
repo:GhoshC01/NODE-APP-DOCKER-EC2-FARGATE:*
repo:GhoshC01@152807108/NODE-APP-DOCKER-EC2-FARGATE@<REPO_ID>:*
```

---

# PART A: EC2 Deployment

## A1. Architecture

```
 git push (app/**)
      │
      ▼
 GitHub Actions ──(OIDC)──▶ IAM role: node-app-github-deploy
      │
      ├─ 1. docker build
      ├─ 2. docker push ─────────▶ ECR: node-app
      └─ 3. ssm send-command ────▶ EC2 instance (Amazon Linux 2023)
                                      │  docker pull from ECR
                                      │  docker run -p 80:3000
                                      │             -v /opt/app/data:/app/data
                                      ▼
                              Browser ─▶ http://<EC2_PUBLIC_IP>
```

## A2. AWS Services Used

| Service | What it is | Why we need it |
|---|---|---|
| **Amazon ECR** | Private Docker image registry | Stores the app image built by the pipeline |
| **Amazon EC2** | A virtual machine | Runs Docker and the app container |
| **Amazon EBS** | The EC2 machine's disk | Holds the persistent folder `/opt/app/data` |
| **IAM role + instance profile** | Identity for the EC2 machine | Lets the machine pull from ECR and receive SSM commands |
| **Security group** | Firewall for the machine | Opens port 80 to the world; no SSH |
| **AWS Systems Manager (SSM)** | Remote command service | Lets the pipeline run commands on the machine without SSH keys |
| **IAM role for GitHub** | Identity for the pipeline | Push to ECR and send SSM commands, nothing else |

## A3. Service Specifications

### Amazon ECR

| Setting | Value | Notes |
|---|---|---|
| Repository name | `node-app` | |
| Image tag | git commit SHA, e.g. `node-app:3e3e1a4...` | Every deploy has a unique, traceable tag |
| Scan on push | Enabled | Free vulnerability scan |
| Force delete | `true` | `terraform destroy` removes it even when it has images |

Example image URI:
```
<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/node-app:3e3e1a4c9f...
```

### Amazon EC2

| Setting | Value | Notes |
|---|---|---|
| Instance type | `t3.micro` | 2 vCPU, 1 GB RAM |
| Operating system | Amazon Linux 2023 (x86_64) | Latest AMI looked up from SSM Parameter Store |
| Public IP | Yes | Example: `15.252.140.108` |
| Name tag | `node-app-dev` | |
| SSH key pair | **None** | Access is only through SSM |
| AMI changes | Ignored (`lifecycle.ignore_changes = [ami]`) | Prevents the machine and its data from being replaced when AWS releases a new AMI |

Startup script (`user_data`), runs once on first boot:
```bash
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /opt/app/data
```

### Amazon EBS (root volume)

| Setting | Value |
|---|---|
| Size | 20 GB |
| Type | `gp3` |
| Persistent folder | `/opt/app/data` |

### IAM role for the EC2 machine

| Setting | Value |
|---|---|
| Role name | `node-app-ec2-role` |
| Instance profile | `node-app-ec2-profile` |
| Trusted entity | `ec2.amazonaws.com` |
| Policies | `AmazonSSMManagedInstanceCore`, `AmazonEC2ContainerRegistryReadOnly` |

### Security group

| Direction | Port | Source / Destination | Reason |
|---|---|---|---|
| Ingress | 80 / TCP | `0.0.0.0/0` | Public website |
| Ingress | 22 | **Not open** | No SSH. SSM is used instead |
| Egress | All | `0.0.0.0/0` | Pull images, install packages |

### IAM role for GitHub Actions

| Setting | Value |
|---|---|
| Role name | `node-app-github-deploy` |
| GitHub secret | `AWS_ROLE_ARN` |

| Permission | Scope |
|---|---|
| `ecr:GetAuthorizationToken` | `*` (required by AWS) |
| ECR push actions | Only the `node-app` repository |
| `ssm:SendCommand` | Only this one instance and the `AWS-RunShellScript` document |
| `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations` | `*` (read results) |

## A4. Persistent Storage on EC2

```
EC2 disk (EBS)                         Container
/opt/app/data   ◀──── bind mount ────▶  /app/data
(permanent)                             (the app writes here)
```

| Event | Files kept? |
|---|---|
| New deployment (container replaced) | Yes |
| EC2 reboot or stop/start | Yes |
| EC2 instance terminated | **No** (root disk is deleted with the instance) |

## A5. CI/CD Pipeline (`.github/workflows/deploy-ec2.yml`)

Trigger: push to `main` that changes `app/**` or the workflow file, or manual run.

| Step | What happens |
|---|---|
| 1. Checkout | Gets the code |
| 2. AWS login | OIDC, assumes `AWS_ROLE_ARN` |
| 3. ECR login | `aws-actions/amazon-ecr-login@v2` |
| 4. Build and push | `docker build ./app`, tag with commit SHA, push to ECR |
| 5. Deploy via SSM | Sends 5 commands to the instance (below) and waits for them to finish |
| 6. Validate | `curl` the site and check the response contains the commit SHA (6 tries, 10 s apart) |

Commands run on the EC2 machine through SSM:
```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <REGISTRY>
docker pull <IMAGE>
docker rm -f node-app || true
docker run -d --name node-app --restart unless-stopped \
  -p 80:3000 -v /opt/app/data:/app/data \
  -e APP_VERSION=<COMMIT_SHA> <IMAGE>
docker image prune -f
```

## A6. EC2 Commands

### Create the infrastructure
```bash
cd terraform/ec2
terraform init
terraform plan
terraform apply
terraform output
```

### Check the machine is reachable through SSM
```bash
aws ssm describe-instance-information \
  --query "InstanceInformationList[].[InstanceId,PingStatus]" --output table
```
Expected: the instance ID with `Online`.

### Open a shell on the machine (no SSH needed)
```bash
aws ssm start-session --target <INSTANCE_ID>
```
Then, inside the session:
```bash
sudo docker ps
sudo docker logs node-app
ls /opt/app/data
```
(Requires the Session Manager plugin for the AWS CLI on your laptop.)

### Test the app
```bash
curl http://<EC2_PUBLIC_IP>
curl http://<EC2_PUBLIC_IP>/health
curl http://<EC2_PUBLIC_IP>/create
curl http://<EC2_PUBLIC_IP>/files
```

### Prove the volume works
```bash
curl http://<EC2_PUBLIC_IP>/create      # create a few files
# change something in app/server.js, then:
git add . && git commit -m "small change" && git push
# after the pipeline is green:
curl http://<EC2_PUBLIC_IP>/files       # old files are still listed
```

### Delete everything
```bash
cd terraform/ec2
terraform destroy
```
Also disable the workflow: GitHub → Actions → Deploy to EC2 → ··· → Disable workflow.

---

# PART B: Fargate Deployment

## B1. Architecture

```
 git push (app/**)
      │
      ▼
 GitHub Actions ──(OIDC)──▶ IAM role: node-app-fargate-github-deploy
      │
      ├─ 1. docker build + push ───────▶ ECR: node-app-fargate
      ├─ 2. download task definition
      ├─ 3. replace image + APP_VERSION
      ├─ 4. register new revision, update service
      └─ 5. desired count = 1, wait until stable
                         │
                         ▼
   ECS Cluster: node-app-fargate
   └── Service: node-app-fargate
       └── Task (container "app", port 3000, public IP)
               │
               │  /app/data  (NFS port 2049, encrypted, IAM checked)
               ▼
           EFS: /app-data  (via access point)

   Browser ─▶ http://<TASK_PUBLIC_IP>:3000
```

## B2. AWS Services Used

| Service | What it is | Why we need it |
|---|---|---|
| **Amazon ECR** | Private Docker image registry | Stores the app image |
| **Amazon ECS** | Container orchestration | Cluster, task definition and service that run the container |
| **AWS Fargate** | Serverless compute for ECS | Runs the container with no machine to manage |
| **Amazon EFS** | Network file system | Persistent storage shared by any task, in any Availability Zone |
| **Security groups (2)** | Firewalls | One for the task (port 3000), one for EFS (port 2049, task only) |
| **IAM execution role** | Identity used by AWS to start the task | Pull the image, write logs |
| **IAM task role** | Identity used by the running app | Mount and write to EFS |
| **Amazon CloudWatch Logs** | Log storage | Container output (`console.log`), since there is no machine to log in to |
| **IAM role for GitHub** | Identity for the pipeline | Push to ECR, update the ECS service, find the task IP |

## B3. Service Specifications

### Amazon ECR

| Setting | Value |
|---|---|
| Repository name | `node-app-fargate` |
| Image tag | git commit SHA |
| Scan on push | Enabled |
| Force delete | `true` |

### ECS Cluster

| Setting | Value |
|---|---|
| Name | `node-app-fargate` |

### ECS Task Definition (the "recipe")

| Setting | Value | Notes |
|---|---|---|
| Family | `node-app-fargate` | Each deploy creates a new revision (`:1`, `:2`, …) |
| Launch type | `FARGATE` | |
| Network mode | `awsvpc` | Each task gets its own network interface and IP |
| CPU / memory | `256` / `512` | 0.25 vCPU, 0.5 GB, the smallest size |
| Platform | Linux, `X86_64` | |
| Container name | `app` | |
| Port | `3000` | |
| Environment | `APP_VERSION` | Set to the commit SHA by the pipeline |
| Mount | volume `data` → `/app/data` | |
| Logs | `awslogs` → `/ecs/node-app-fargate`, prefix `app` | |
| Health check | `wget -qO- http://localhost:3000/health` | Every 30 s, timeout 5 s, 3 retries, 10 s start period |

How the task definition maps to the EC2 `docker run` command:

| EC2 `docker run` | Fargate task definition |
|---|---|
| `IMAGE` | `image` |
| `-p 80:3000` | `portMappings` → `3000` |
| `-e APP_VERSION=...` | `environment` |
| `-v /opt/app/data:/app/data` | `volume` (EFS) + `mountPoints` |
| `--restart unless-stopped` | ECS service + `healthCheck` |
| `docker logs` | `logConfiguration` → CloudWatch Logs |

### ECS Service (the "manager")

| Setting | Value | Notes |
|---|---|---|
| Name | `node-app-fargate` | |
| Desired count (Terraform) | `0` | The ECR repository is empty when Terraform runs |
| Desired count (after deploy) | `1` | Set by the pipeline |
| Subnets | All default VPC subnets | |
| Public IP | Assigned | Needed to pull from ECR and to open the site, since there is no load balancer |
| Depends on | EFS mount targets | The task must not start before EFS is reachable |
| Ignored changes | `task_definition`, `desired_count` | The pipeline owns these after the first apply |

### Amazon EFS

| Part | Setting | Value |
|---|---|---|
| File system | Creation token | `node-app-fargate-data` |
| | Encrypted at rest | Yes |
| | Example ID | `fs-044390ade0d562292` |
| Mount targets | One per default subnet | 3 in `ap-south-1` (one per Availability Zone) |
| | Security group | EFS security group |
| Access point | Root directory | `/app-data` (created automatically) |
| | POSIX user | UID `1000`, GID `1000` |
| | Directory permissions | `755`, owner `1000:1000` |
| Volume in task | Transit encryption | Enabled |
| | IAM authorization | Enabled (the task role must allow it) |

Folder layout on EFS:
```
EFS
└── /app-data/          ← the only folder the app can see (as /app/data)
    ├── file-1793373891227-2.json
    └── file-1793373957742-3.json
```

### Security groups

**Task security group** (`node-app-fargate-task-sg`)

| Direction | Port | Source / Destination | Reason |
|---|---|---|---|
| Ingress | 3000 / TCP | `0.0.0.0/0` | Public access to the app |
| Egress | All | `0.0.0.0/0` | ECR, EFS, CloudWatch |

**EFS security group** (`node-app-fargate-efs-sg`)

| Direction | Port | Source / Destination | Reason |
|---|---|---|---|
| Ingress | 2049 / TCP | **Task security group only** | Only app containers can reach the file system |
| Egress | All | `0.0.0.0/0` | Default |

### IAM roles

**Execution role** (`node-app-fargate-execution`): used by AWS **before** the container starts.

| Setting | Value |
|---|---|
| Trusted entity | `ecs-tasks.amazonaws.com` |
| Policy | `AmazonECSTaskExecutionRolePolicy` (pull from ECR, write logs) |

**Task role** (`node-app-fargate-task`): used by the app **while** it runs.

| Permission | Scope |
|---|---|
| `elasticfilesystem:ClientMount`, `elasticfilesystem:ClientWrite` | Only this file system, and only through this access point |

**GitHub role** (`node-app-fargate-github-deploy`), GitHub secret `AWS_FARGATE_ROLE_ARN`:

| Permission | Scope |
|---|---|
| `ecr:GetAuthorizationToken` | `*` |
| ECR push actions | Only `node-app-fargate` |
| `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition` | `*` |
| `ecs:UpdateService`, `ecs:DescribeServices` | Only this service |
| `ecs:ListTasks`, `ecs:DescribeTasks`, `ec2:DescribeNetworkInterfaces` | `*` (find the task IP) |
| `iam:PassRole` | Only the execution and task roles, only to `ecs-tasks.amazonaws.com` |

`iam:PassRole` is needed because registering a task definition hands the two roles to ECS. The condition stops the pipeline from handing out any other role.

### CloudWatch Logs

| Setting | Value |
|---|---|
| Log group | `/ecs/node-app-fargate` |
| Retention | 7 days |

## B4. Persistent Storage on Fargate

```
Old task (any AZ) ──┐
                    ├──▶  EFS /app-data  (permanent, outside every task)
New task (any AZ) ──┘
```

| Event | Files kept? |
|---|---|
| New deployment (new task, new IP) | Yes |
| Task crashes and is restarted | Yes |
| Task starts in a different Availability Zone | Yes |
| `terraform destroy` | **No** (EFS is deleted) |

## B5. CI/CD Pipeline (`.github/workflows/deploy-fargate.yml`)

Trigger: push to `main` that changes `app/**` or the workflow file, or manual run.

| Step | What happens |
|---|---|
| 1. Checkout and AWS login | OIDC, assumes `AWS_FARGATE_ROLE_ARN` |
| 2. Build and push | Image tagged with the commit SHA |
| 3. Download task definition | `aws ecs describe-task-definition` |
| 4. Render | `amazon-ecs-render-task-definition@v1` replaces only the image and `APP_VERSION` |
| 5. Deploy | `amazon-ecs-deploy-task-definition@v2` registers a new revision and points the service to it |
| 6. Scale and wait | `desired-count 1`, then `aws ecs wait services-stable` |
| 7. Find IP | Task → network interface → public IP. The URL is shown in the run summary |
| 8. Validate | `curl` the URL and check for the commit SHA (6 tries, 10 s apart) |

Everything else in the task definition (EFS volume, roles, logs, health check) comes from Terraform and is not touched by the pipeline.

## B6. Fargate Commands

### Create the infrastructure
```bash
cd terraform/fargate
terraform init
terraform plan
terraform apply
terraform output
```

### Check the service
```bash
aws ecs describe-services \
  --cluster node-app-fargate --services node-app-fargate \
  --query "services[0].[status,desiredCount,runningCount,taskDefinition]" --output table
```

### Find the current app URL
```bash
TASK_ARN=$(aws ecs list-tasks --cluster node-app-fargate --service-name node-app-fargate \
  --desired-status RUNNING --query "taskArns[0]" --output text)

ENI_ID=$(aws ecs describe-tasks --cluster node-app-fargate --tasks $TASK_ARN \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)

aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID \
  --query "NetworkInterfaces[0].Association.PublicIp" --output text
```
Open `http://<THAT_IP>:3000`.

### Watch the logs live
```bash
aws logs tail /ecs/node-app-fargate --follow
```

### List task definition revisions
```bash
aws ecs list-task-definitions --family-prefix node-app-fargate --sort DESC
```

### Roll back to an older revision
```bash
aws ecs update-service --cluster node-app-fargate --service node-app-fargate \
  --task-definition node-app-fargate:<REVISION_NUMBER>
```

### Check EFS
```bash
aws efs describe-file-systems --query "FileSystems[].[FileSystemId,Name,SizeInBytes.Value]" --output table
aws efs describe-mount-targets --file-system-id <EFS_ID> \
  --query "MountTargets[].[AvailabilityZoneName,LifeCycleState]" --output table
```

### Test the app
```bash
curl http://<TASK_IP>:3000
curl http://<TASK_IP>:3000/health
curl http://<TASK_IP>:3000/create
curl http://<TASK_IP>:3000/files
```

### Prove the volume works
```bash
curl http://<TASK_IP>:3000/create        # create a few files
# change something in app/server.js, then:
git add . && git commit -m "small change" && git push
# after the pipeline is green, open the NEW URL from the run summary:
curl http://<NEW_TASK_IP>:3000/files     # old files are still listed
```

### Stop the container (keep everything else)
```bash
aws ecs update-service --cluster node-app-fargate --service node-app-fargate --desired-count 0
```
Start again with a push, or GitHub → Actions → Deploy to Fargate → Run workflow.

### Delete everything
```bash
cd terraform/fargate
terraform destroy
```

---

# PART C: Side-by-Side Comparison

| Topic | EC2 | Fargate |
|---|---|---|
| Who manages the machine | We do (OS, Docker, updates) | AWS |
| What runs the container | `docker run` sent over SSM | ECS service from a task definition |
| Public URL | `http://<EC2_IP>` (port 80) | `http://<TASK_IP>:3000` |
| Does the IP change on deploy? | No | Yes (no load balancer) |
| Persistent storage | Folder on the EC2 disk (bind mount) | EFS through an access point |
| Data survives deleting the compute? | No | Yes (EFS is separate) |
| Restart on failure | `--restart unless-stopped` | ECS health check replaces the task |
| Logs | `docker logs` on the machine | CloudWatch Logs |
| Remote access | SSM Session Manager | Not needed |
| IAM roles | 1 for the machine + 1 for GitHub | Execution + task + GitHub |
| Rollback | Re-run an older commit | Point the service to an older revision |
| Cost while idle | Instance, disk and public IP keep billing | Nothing for compute at `desiredCount = 0` (small EFS/ECR storage only) |

---

# PART D: Security Summary

- **No long-lived AWS keys.** GitHub Actions uses OIDC and short-lived credentials.
- **Trust is locked to this repository** by the `sub` condition in each GitHub role.
- **Least privilege.** Each role can only touch its own resources (one ECR repository, one instance or one service, one file system).
- **No SSH** on EC2. Port 22 is closed; SSM is used instead.
- **EFS is reachable only from app tasks** (security group) **and only with the task role** (IAM authorization).
- **Encryption.** EFS is encrypted at rest and in transit.
- **Image scanning** is enabled on both ECR repositories.

---

# PART E: Troubleshooting Notes

| Symptom | Cause | Fix |
|---|---|---|
| Workflow never runs | Folder named `.github/.workflows` | Rename to `.github/workflows` |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` in the trust policy does not match the token | Include both `sub` formats (see section 3) |
| `Request ARN is invalid` | Secret holds the OIDC provider ARN | Use the **role** ARN (contains `:role/`) |
| EC2 deploy fails at SSM | Instance not `Online` in SSM | Wait 2–3 minutes after creation; check the instance role |
| Fargate task stops right away | EFS mount failed | Check EFS security group (2049 from task SG), task role, and that mount targets are `available` |
| Fargate validation fails | Task still starting or health check failing | `aws logs tail /ecs/node-app-fargate --follow` |
| Red EC2 run after EC2 was destroyed | EC2 workflow still enabled | Disable "Deploy to EC2" in GitHub Actions |
