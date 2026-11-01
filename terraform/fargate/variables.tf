variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "app_name" {
  type    = string
  default = "node-app"
}

variable "container_port" {
  type    = number
  default = 3000
}