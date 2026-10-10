import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

export function validationException(errors: ValidationError[]) {
  const fieldErrors: Array<{ field: string; message: string }> = [];
  const walk = (nodes: ValidationError[], prefix = '') => {
    for (const node of nodes) {
      const field = prefix ? `${prefix}.${node.property}` : node.property;
      for (const message of Object.values(node.constraints ?? {})) fieldErrors.push({ field, message });
      walk(node.children ?? [], field);
    }
  };
  walk(errors);
  return new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Dữ liệu nhập chưa hợp lệ', fieldErrors });
}
