# ─────────── আগে থেকে যা আছে ───────────

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ─────────── ECR: image-এর গুদাম ───────────

resource "aws_ecr_repository" "app" {
  name         = "${var.app_name}-fargate"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ─────────── পাহারাদার ১: container-এর দরজা ───────────

resource "aws_security_group" "task" {
  name   = "${var.app_name}-fargate-task-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─────────── পাহারাদার ২: EFS লকারের দরজা ───────────

resource "aws_security_group" "efs" {
  name   = "${var.app_name}-fargate-efs-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─────────── EFS: লকার রুম ───────────

resource "aws_efs_file_system" "data" {
  creation_token = "${var.app_name}-fargate-data"
  encrypted      = true

  tags = {
    Name = "${var.app_name}-fargate-data"
  }
}

# ─────────── প্রতিটা এলাকায় একটা দরজা ───────────

resource "aws_efs_mount_target" "data" {
  for_each = toset(data.aws_subnets.default.ids)

  file_system_id  = aws_efs_file_system.data.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

# ─────────── app-এর নিজস্ব লকার ───────────

resource "aws_efs_access_point" "data" {
  file_system_id = aws_efs_file_system.data.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/app-data"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }
}

# ─────────── দুটো role-এর জন্য একই trust policy ───────────
# "শুধু ECS-এর container এই পরিচয়পত্র পরতে পারবে"

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ─────────── 🚚 Execution Role ───────────

resource "aws_iam_role" "execution" {
  name               = "${var.app_name}-fargate-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ─────────── 👷 Task Role ───────────

resource "aws_iam_role" "task" {
  name               = "${var.app_name}-fargate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_efs" {
  name = "efs-access"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = aws_efs_file_system.data.arn
      Condition = {
        StringEquals = {
          "elasticfilesystem:AccessPointArn" = aws_efs_access_point.data.arn
        }
      }
    }]
  })
}

# ─────────── 📒 লগের খাতা ───────────

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.app_name}-fargate"
  retention_in_days = 7
}

# ─────────── 🏬 Cluster ───────────

resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-fargate"
}

# ─────────── 📋 Task Definition (রেসিপি) ───────────

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.app_name}-fargate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "app"
    image     = "${aws_ecr_repository.app.repository_url}:latest"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [{
      name  = "APP_VERSION"
      value = "terraform-initial"
    }]

    mountPoints = [{
      sourceVolume  = "data"
      containerPath = "/app/data"
      readOnly      = false
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "app"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:${var.container_port}/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])

  volume {
    name = "data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.data.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "ENABLED"
      }
    }
  }
}

# ─────────── 👔 Service (ম্যানেজার) ───────────

resource "aws_ecs_service" "app" {
  name            = "${var.app_name}-fargate"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"
  desired_count   = 0

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  depends_on = [aws_efs_mount_target.data]

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}