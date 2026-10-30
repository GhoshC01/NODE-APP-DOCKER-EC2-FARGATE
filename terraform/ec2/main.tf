# ─────────── আগে থেকে যা আছে, খুঁজে আনো ───────────

# AWS প্রতিটা অ্যাকাউন্টে একটা "default VPC" (নেটওয়ার্ক) দিয়ে রাখে
data "aws_vpc" "default" {
  default = true
}

# সেই নেটওয়ার্কের ভেতরের subnet গুলো
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# সর্বশেষ Amazon Linux 2023 operating system-এর ID
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# ─────────── ECR: Docker image-এর গুদাম ───────────

resource "aws_ecr_repository" "app" {
  name         = var.app_name
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ─────────── EC2-এর পরিচয়পত্র (IAM Role) ───────────

# ১. Role বানাও, আর বলো "শুধু EC2 এটা পরতে পারবে"
resource "aws_iam_role" "ec2" {
  name = "${var.app_name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# ২. অনুমতি: SSM দিয়ে নির্দেশ শোনা
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ৩. অনুমতি: ECR থেকে image পড়া
resource "aws_iam_role_policy_attachment" "ecr" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# ৪. Role-টা EC2-এর গায়ে লাগানোর "কার্ড হোল্ডার"
resource "aws_iam_instance_profile" "ec2" {
  name = "${var.app_name}-ec2-profile"
  role = aws_iam_role.ec2.name
}

# ─────────── Security Group: দরজার পাহারাদার ───────────

resource "aws_security_group" "app" {
  name   = "${var.app_name}-sg"
  vpc_id = data.aws_vpc.default.id

  # ভেতরে আসতে দাও: শুধু port 80 (ওয়েবসাইট)
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # বাইরে যেতে দাও: সব (image টানা, আপডেট ইত্যাদির জন্য)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─────────── EC2 মেশিন ───────────

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  # মেশিন প্রথমবার চালু হলে এই কমান্ডগুলো নিজে চলবে
  user_data = <<-EOF
    #!/bin/bash
    dnf install -y docker
    systemctl enable --now docker
    usermod -aG docker ec2-user
    mkdir -p /opt/app/data
  EOF

  user_data_replace_on_change = true

  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${var.app_name}-dev"
  }
}