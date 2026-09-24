/** 业务错误：带 HTTP 状态码和稳定的错误码，路由层统一转成 JSON。 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
