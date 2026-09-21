import { Injectable } from '@nestjs/common';

@Injectable()
export class ReadinessService {
  private ready = true;

  isReady(): boolean {
    return this.ready;
  }

  setReady(value: boolean): void {
    this.ready = value;
  }
}
