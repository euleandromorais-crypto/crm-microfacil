export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'Não autenticado') => new AppError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Você não tem permissão para esta ação') => new AppError(403, msg, 'forbidden');
export const notFound = (msg = 'Registro não encontrado') => new AppError(404, msg, 'not_found');
export const conflict = (msg: string, details?: unknown) => new AppError(409, msg, 'conflict', details);
