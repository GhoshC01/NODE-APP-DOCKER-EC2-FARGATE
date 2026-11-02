data "archive_file" "hello" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambda/hello"
  output_path = "${path.module}/build/hello.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.app_name}-hello-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "hello" {
  name              = "/aws/lambda/${var.app_name}-hello"
  retention_in_days = 7
}

resource "aws_lambda_function" "hello" {
  function_name = "${var.app_name}-hello"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"

  filename         = data.archive_file.hello.output_path
  source_code_hash = data.archive_file.hello.output_base64sha256

  depends_on = [aws_cloudwatch_log_group.hello]
}
