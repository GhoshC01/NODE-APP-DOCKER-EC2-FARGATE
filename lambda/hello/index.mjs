export const handler = async (event) => {
  const body = {
    app: "hello-lambda",
    message: "Hello from AWS Lambda! 👋",
    path: event.rawPath || "/",
    method: event.requestContext?.http?.method || "GET",
    time: new Date().toISOString(),
  };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
};
