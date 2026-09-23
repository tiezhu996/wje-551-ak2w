import type { TransferOrder } from '../types/index.js';
import { TransferStatus } from '../constants/enums.js';
export type TransferOrderEntity = TransferOrder;
export const transferStatuses = Object.values(TransferStatus);
