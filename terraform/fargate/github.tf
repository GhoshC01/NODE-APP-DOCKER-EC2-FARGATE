data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github" {
  name = "${var.app_name}-fargate-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = [
            "repo:GhoshC01/NODE-APP-DOCKER-EC2-FARGATE:*",
            "repo:GhoshC01@152807108/NODE-APP-DOCKER-EC2-FARGATE@1438719890:*"
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github" {
  name = "fargate-deploy-permissions"
  role = aws_iam_role.github.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage"
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Sid    = "EcsTaskDefinition"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition"
        ]
        Resource = "*"
      },
      {
        Sid      = "EcsUpdateService"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = aws_ecs_service.app.id
      },
      {
        Sid    = "FindTaskIp"
        Effect = "Allow"
        Action = [
          "ecs:ListTasks",
          "ecs:DescribeTasks",
          "ec2:DescribeNetworkInterfaces"
        ]
        Resource = "*"
      },
      {
        Sid      = "PassRolesToEcs"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      }
    ]
  })
}

output "github_role_arn" {
  value = aws_iam_role.github.arn
}