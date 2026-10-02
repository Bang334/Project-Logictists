import { readFileSync } from 'fs';
import { join } from 'path';

describe('Simplified demo database contract', () => {
  it('có đúng 66 model nghiệp vụ', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect([...schema.matchAll(/^model\s+\w+\s*\{/gm)]).toHaveLength(66);
  });
  it('không còn bảng ca và pick task riêng', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^model\s+(WorkShift|ShiftAssignment|PickTask|FulfillmentOrder)\s*\{/m);
  });
});
