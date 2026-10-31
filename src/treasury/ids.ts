import { randomUUID } from "node:crypto";

export class IdempotencyKeys {
  private readonly keys = new Map<string, string>();

  get(operation: string): string {
    let id = this.keys.get(operation);
    if (!id) {
      id = randomUUID();
      this.keys.set(operation, id);
    }
    return id;
  }

  clear(): void {
    this.keys.clear();
  }
}
