export class RenderCancelledError extends Error {
  constructor() {
    super('Render request cancelled');
    this.name = 'RenderCancelledError';
  }
}
