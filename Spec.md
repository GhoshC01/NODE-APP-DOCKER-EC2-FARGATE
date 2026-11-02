# Spec: Node.js App on EC2, Fargate, and API Gateway

This document describes one small Node.js app, packaged with Docker and deployed to AWS in two ways, plus a second tiny function and one HTTP API in front of both:

1. **EC2**: a virtual machine that we manage ourselves.
2. **Fargate**: serverless containers on ECS, with no machine to manage.
3. **API Gateway**: one HTTP API. `/node` reaches the Fargate app. `/hello` reaches a Lambda function.

Both container deployments keep the files the app creates in a **persistent volume**, so the files survive when the container is replaced. Both are deployed automatically by **GitHub Actions** and built with **Terraform**. The Lambda and the API are created by Terraform in `terraform/gateway`. There is no GitHub Actions workflow for them. DNS for the custom domain is added by hand in Cloudflare. Terraform does not manage Cloudflare.

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

### Hello Lambda

A second application, `lambda/hello/index.mjs`. It is not in Docker and it has no npm packages and no `package.json`.

| Item | Value |
|---|---|
| Runtime | Node.js 22 (`nodejs22.x`) |
| Handler | `index.handler` |
| Function name | `node-app-hello` |
| Event format | API Gateway HTTP API, payload format 2.0 |

`GET /hello` returns JSON:

| Field | Value |
|---|---|
| `app` | `hello-lambda` |
| `message` | `Hello from AWS Lambda! 👋` |
| `path` | `event.rawPath`, or `/` |
| `method` | `event.requestContext.http.method`, or `GET` |
| `time` | Current time in ISO format |

---

## 2. Repository Layout

```
NODE-APP-DOCKER-EC2-FARGATE/
├── app/
│   ├── server.js
│   └── Dockerfile
├── lambda/
│   └── hello/
│       └── index.mjs
├── terraform/
│   ├── ec2/
│   │   ├── providers.tf
│   │   ├── variables.tf
│   │   ├── main.tf
│   │   ├── github.tf
│   │   └── outputs.tf
│   ├── fargate/
│   │   ├── providers.tf
│   │   ├── variables.tf
│   │   ├── main.tf
│   │   ├── github.tf
│   │   └── outputs.tf
│   └── gateway/
│       ├── providers.tf
│       ├── variables.tf
│       ├── lambda.tf
│       ├── fargate.tf
│       ├── api.tf
│       ├── domain.tf
│       └── outputs.tf
├── .github/workflows/
│   ├── deploy-ec2.yml
│   └── deploy-fargate.yml
├── .gitignore
└── Spec.md
```

`terraform/gateway/build/` is the Lambda zip. It is gitignored. `.terraform/` and `*.tfstate` are already ignored for every stack.

---

## 3. Shared Foundations (used by all three)

These pieces were created once, by hand, before either deployment.

| Item | Example value | Purpose |
|---|---|---|
| AWS region | `ap-south-1` (Mumbai) | Where everything runs, including the API certificate |
| Terraform state bucket | `my-tf-state-bucket-ui-static-page-practice` | Stores Terraform state. Keys: `ec2/terraform.tfstate`, `fargate/terraform.tfstate`, `gateway/terraform.tfstate` |
| GitHub OIDC identity provider | `token.actions.githubusercontent.com` | Lets GitHub Actions log in to AWS without stored keys |
| Default VPC and subnets | Provided by AWS | Network for both deployments and for the API Gateway VPC link. No custom VPC is created |
| Domain | `digirg.dpdns.org` in Cloudflare | Terraform does not manage it. `api.digirg.dpdns.org` is added by hand |

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

   The running task also registers itself in Cloud Map:
   node.node-app.local  (SRV record, port 3000)
   API Gateway uses that name. See Part C.

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
| **AWS Cloud Map** | Private DNS for the task | The ECS service registers itself. API Gateway finds the task through this name |
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
| Public IP | Assigned | Needed to pull from ECR and to open the site directly. API Gateway is a second way in |
| Cloud Map | `service_registries` | Registers container `app`, port `3000` |
| Depends on | EFS mount targets | The task must not start before EFS is reachable |
| Ignored changes | `task_definition`, `desired_count` | The pipeline owns these after the first apply |

### AWS Cloud Map

The ECS service writes its own address into a private DNS namespace in the default VPC. API Gateway does not use the task's public IP.

| Setting | Value | Notes |
|---|---|---|
| Namespace | `node-app.local` | Private DNS, default VPC |
| Service name | `node` | Full name `node.node-app.local` |
| Record type | `SRV` | Carries the task IP and port 3000 |
| Routing | `MULTIVALUE` | |
| TTL | 10 seconds | |
| Terraform output | `discovery_service_arn` | `terraform/gateway` reads this from the Fargate state |

Apply `terraform/fargate` before `terraform/gateway`, so this output is saved in the Fargate state.

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

# PART C: API Gateway and Lambda

One Amazon API Gateway HTTP API sits in front of two applications. The Fargate app stays on its task IP as well. EC2 is not behind this API.

```
                         Cloudflare DNS (by hand, not Terraform)
                         api.digirg.dpdns.org
                                  │
                                  ▼
                    API Gateway HTTP API: node-app-api
                    stage: $default    TLS certificate in ap-south-1
                         │                          │
           ANY /node, /node/*                       ANY /hello, /hello/*
           strip the /node prefix                   payload format 2.0
                         │                          │
                         ▼                          ▼
                  VPC Link                          Lambda: node-app-hello
                  (default subnets)                 (no VPC)
                         │
                         ▼
                  Cloud Map SRV: node.node-app.local
                         │
                         ▼
                  Fargate task :3000
```

## C1. Routes

| Route | Integration | What the app receives |
|---|---|---|
| `ANY /node` | VPC Link → Cloud Map | Path rewritten to `/` |
| `ANY /node/{proxy+}` | VPC Link → Cloud Map | Path rewritten to `/{proxy}`, so `/node/health` arrives as `/health` |
| `ANY /hello` | Lambda `node-app-hello` | The original HTTP API event |
| `ANY /hello/{proxy+}` | Same Lambda | The original HTTP API event |

Both Fargate integrations are `HTTP_PROXY` with method `ANY`. The connection is the VPC link, and `integration_uri` is `discovery_service_arn` from the Fargate remote state.

| Integration | `overwrite:path` |
|---|---|
| `node_root` | `/` |
| `node_proxy` | `/$request.path.proxy` |

The Lambda integration is `AWS_PROXY` with `payload_format_version = "2.0"`. API Gateway is allowed to invoke the function (`source_arn` is the API execution ARN plus `/*/*`).

## C2. AWS Services Used

| Service | What it is | Why we need it |
|---|---|---|
| **API Gateway HTTP API** | One public HTTPS API | Stable URL for both apps. Name `node-app-api`, stage `$default`, `auto_deploy = true` |
| **VPC Link** | Private connection into the default VPC | Reaches the Fargate task without a public load balancer. Name `node-app-vpc-link` |
| **Cloud Map** | Created in `terraform/fargate` | Tells the VPC link which task IP and port to call |
| **Lambda** | `node-app-hello` | The `/hello` application |
| **IAM role** | `node-app-hello-lambda` | Lets Lambda write its own logs, and nothing else |
| **CloudWatch Logs** | `/aws/lambda/node-app-hello` | Lambda output. Kept for 7 days |
| **ACM** | Certificate for `api.digirg.dpdns.org` | TLS on the custom domain. Same region as the API, `ap-south-1` |
| **Cloudflare** | DNS for `digirg.dpdns.org` | Not in Terraform. Records are added by hand |

## C3. Lambda

Terraform zips `lambda/hello` into `terraform/gateway/build/hello.zip` on every plan. That folder is gitignored.

| Setting | Value |
|---|---|
| Function name | `node-app-hello` |
| Runtime | `nodejs22.x` |
| Handler | `index.handler` |
| Role | `node-app-hello-lambda` |
| Policy | `AWSLambdaBasicExecutionRole` only |
| Log group | `/aws/lambda/node-app-hello`, 7 days |
| Deploy | `terraform apply` in `terraform/gateway`. No GitHub Actions workflow |

A change to `lambda/hello/index.mjs` is published by running `terraform apply` again. The zip hash is the function's `source_code_hash`.

## C4. Network

**VPC link security group** (`node-app-vpc-link-sg`)

| Direction | Port | Source / Destination | Reason |
|---|---|---|---|
| Ingress | None | | API Gateway does not accept connections on this group |
| Egress | All | `0.0.0.0/0` | Call the Fargate task on port 3000 |

The task security group already allows port 3000 from the internet, so the VPC link can reach the container. The link uses every subnet in the default VPC.

`terraform/gateway/fargate.tf` reads the Fargate state from S3 (`fargate/terraform.tfstate`) and looks up the default VPC and its subnets. It does not create them.

## C5. Custom Domain

The domain name variable defaults to `api.digirg.dpdns.org`.

| Resource | Setting |
|---|---|
| `aws_acm_certificate.api` | DNS validation, `create_before_destroy` |
| `aws_acm_certificate_validation.api` | Waits until the certificate is `ISSUED`. No `validation_record_fqdns`, because Cloudflare is updated by hand |
| `aws_apigatewayv2_domain_name.api` | `REGIONAL` endpoint, security policy `TLS_1_2` |
| `aws_apigatewayv2_api_mapping.api` | Maps the domain to API `node-app-api`, stage `$default` |

The certificate is in `ap-south-1`, the same region as the API. It is not created in `us-east-1`.

Two Cloudflare records, both **DNS only** (grey cloud). An orange-cloud proxy would terminate TLS at Cloudflare and hide the name ACM and API Gateway need to see.

| Record | Type | Name | Target |
|---|---|---|---|
| Certificate check | CNAME | `resource_record_name` from output `acm_validation_records` | `resource_record_value` from that same output |
| API | CNAME | `api` | output `custom_domain_target` |

`terraform apply` creates the certificate first, then waits on validation. Add the validation CNAME in Cloudflare while that wait is running (the name and value are in the ACM console as soon as the certificate exists). After the certificate is issued, apply continues and creates the API domain. Then add the API CNAME from `custom_domain_target`.

## C6. Commands

Apply Fargate first when `discovery_service_arn` is not in its state yet.

```bash
cd terraform/fargate
terraform init
terraform plan
terraform apply
```

```bash
cd terraform/gateway
terraform init
terraform plan
terraform apply
terraform output
```

There is no `-var-file` and no `-backend-config`. Defaults are `ap-south-1`, app name `node-app`, domain `api.digirg.dpdns.org`.

### Test through the default API URL

```bash
cd terraform/gateway
curl "$(terraform output -raw node_url)"
curl "$(terraform output -raw node_url)health"
curl "$(terraform output -raw hello_url)"
```

`node_url` already ends with `/node/`.

### Test through the custom domain

```bash
curl "$(terraform output -raw custom_node_url)"
curl "$(terraform output -raw custom_node_url)health"
curl "$(terraform output -raw custom_node_url)files"
curl "$(terraform output -raw custom_hello_url)"
```

`/node/health` must return `OK` from the Fargate app, not a path that still contains `/node`. `/hello` must return JSON with `"app": "hello-lambda"`.

### Lambda logs

```bash
aws logs tail /aws/lambda/node-app-hello --follow
```

### Delete the API and the Lambda

```bash
cd terraform/gateway
terraform destroy
```

This does not delete the Fargate service, the EC2 instance, or the Cloudflare zone. Remove the two Cloudflare CNAMEs by hand.

---

# PART D: Side-by-Side Comparison

| Topic | EC2 | Fargate |
|---|---|---|
| Who manages the machine | We do (OS, Docker, updates) | AWS |
| What runs the container | `docker run` sent over SSM | ECS service from a task definition |
| Public URL | `http://<EC2_IP>` (port 80) | `http://<TASK_IP>:3000`, and `https://api.digirg.dpdns.org/node/` |
| Does the IP change on deploy? | No | The task IP changes. The API Gateway URL does not |
| Persistent storage | Folder on the EC2 disk (bind mount) | EFS through an access point |
| Data survives deleting the compute? | No | Yes (EFS is separate) |
| Restart on failure | `--restart unless-stopped` | ECS health check replaces the task |
| Logs | `docker logs` on the machine | CloudWatch Logs |
| Remote access | SSM Session Manager | Not needed |
| IAM roles | 1 for the machine + 1 for GitHub | Execution + task + GitHub |
| Rollback | Re-run an older commit | Point the service to an older revision |
| Cost while idle | Instance, disk and public IP keep billing | Nothing for compute at `desiredCount = 0` (small EFS/ECR storage only) |

---

# PART E: Security Summary

- **No long-lived AWS keys.** GitHub Actions uses OIDC and short-lived credentials.
- **Trust is locked to this repository** by the `sub` condition in each GitHub role.
- **Least privilege.** Each role can only touch its own resources (one ECR repository, one instance or one service, one file system).
- **No SSH** on EC2. Port 22 is closed; SSM is used instead.
- **EFS is reachable only from app tasks** (security group) **and only with the task role** (IAM authorization).
- **Encryption.** EFS is encrypted at rest and in transit.
- **Image scanning** is enabled on both ECR repositories.
- **Lambda can only write logs.** Its role has `AWSLambdaBasicExecutionRole` and no other permissions.
- **The VPC link security group has no ingress rules.** It is only used for outbound calls to the task.
- **Cloud Map is private.** The name `node.node-app.local` is not a public DNS name. Only the VPC link, inside the default VPC, uses it.
- **The API certificate is regional.** It lives in `ap-south-1` with the HTTP API.
- **Cloudflare is outside Terraform.** Only the two CNAMEs in section C5 are added there, both as DNS only.

---

# PART F: Troubleshooting Notes

| Symptom | Cause | Fix |
|---|---|---|
| Workflow never runs | Folder named `.github/.workflows` | Rename to `.github/workflows` |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` in the trust policy does not match the token | Include both `sub` formats (see section 3) |
| `Request ARN is invalid` | Secret holds the OIDC provider ARN | Use the **role** ARN (contains `:role/`) |
| EC2 deploy fails at SSM | Instance not `Online` in SSM | Wait 2–3 minutes after creation; check the instance role |
| Fargate task stops right away | EFS mount failed | Check EFS security group (2049 from task SG), task role, and that mount targets are `available` |
| Fargate validation fails | Task still starting or health check failing | `aws logs tail /ecs/node-app-fargate --follow` |
| Red EC2 run after EC2 was destroyed | EC2 workflow still enabled | Disable "Deploy to EC2" in GitHub Actions |
| Gateway plan cannot read `discovery_service_arn` | Fargate was not applied after that output was added | `terraform apply` in `terraform/fargate`, then plan again in `terraform/gateway` |
| `terraform apply` waits on the certificate | Cloudflare validation CNAME is missing, or the record is proxied | Add the CNAME from ACM as DNS only, then leave the apply running |
| Custom domain does not open | API CNAME is missing, or Cloudflare is proxying it | CNAME `api` to `custom_domain_target`, DNS only |
| `/node/health` is not `OK` | The `/node` prefix was not removed | `/node` rewrites to `/`. `/node/{proxy+}` rewrites to `/$request.path.proxy` |
| `/hello` is forbidden | API Gateway cannot invoke the function | `aws_lambda_permission.hello` allows `apigateway.amazonaws.com` |
