import { PodEvidenceType } from "@prisma/client";
import { IsDateString, IsEnum, IsOptional, IsUUID } from "class-validator";

export class UploadDriverPodDto {
  @IsEnum(PodEvidenceType)
  evidenceType!: PodEvidenceType;

  @IsDateString()
  capturedAt!: string;

  @IsUUID()
  idempotencyKey!: string;

  @IsOptional()
  @IsUUID()
  supersedesId?: string;
}
