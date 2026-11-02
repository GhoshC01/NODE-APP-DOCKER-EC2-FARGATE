output "lambda_function_name" {
  value = aws_lambda_function.hello.function_name
}

output "lambda_function_arn" {
  value = aws_lambda_function.hello.arn
}

output "lambda_invoke_arn" {
  value = aws_lambda_function.hello.invoke_arn
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "node_url" {
  value = "${aws_apigatewayv2_api.main.api_endpoint}/node/"
}

output "hello_url" {
  value = "${aws_apigatewayv2_api.main.api_endpoint}/hello"
}

output "acm_validation_records" {
  value = aws_acm_certificate.api.domain_validation_options
}

output "custom_domain_target" {
  value = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
}

output "custom_node_url" {
  value = "https://${var.domain_name}/node/"
}

output "custom_hello_url" {
  value = "https://${var.domain_name}/hello"
}
