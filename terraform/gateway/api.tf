resource "aws_security_group" "vpc_link" {
  name   = "${var.app_name}-vpc-link-sg"
  vpc_id = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${var.app_name}-vpc-link"
  subnet_ids         = data.aws_subnets.default.ids
  security_group_ids = [aws_security_group.vpc_link.id]
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.app_name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "node_root" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id
  integration_uri    = data.terraform_remote_state.fargate.outputs.discovery_service_arn

  request_parameters = {
    "overwrite:path" = "/"
  }
}

resource "aws_apigatewayv2_integration" "node_proxy" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id
  integration_uri    = data.terraform_remote_state.fargate.outputs.discovery_service_arn

  request_parameters = {
    "overwrite:path" = "/$request.path.proxy"
  }
}

resource "aws_apigatewayv2_integration" "hello" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.hello.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "node" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /node"
  target    = "integrations/${aws_apigatewayv2_integration.node_root.id}"
}

resource "aws_apigatewayv2_route" "node_proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /node/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.node_proxy.id}"
}

resource "aws_apigatewayv2_route" "hello" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /hello"
  target    = "integrations/${aws_apigatewayv2_integration.hello.id}"
}

resource "aws_apigatewayv2_route" "hello_proxy" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "ANY /hello/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.hello.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "hello" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hello.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
