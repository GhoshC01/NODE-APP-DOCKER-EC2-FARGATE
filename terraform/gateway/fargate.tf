data "terraform_remote_state" "fargate" {
  backend = "s3"

  config = {
    bucket = "my-tf-state-bucket-ui-static-page-practice"
    key    = "fargate/terraform.tfstate"
    region = "ap-south-1"
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
