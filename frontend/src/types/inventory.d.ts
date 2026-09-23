import type { InventoryAlertLevel, TransferStatus } from '../constants/enums';

export interface Warehouse {
  id: string;
  name: string;
  address: string;
  capacity: number;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}

export interface Inventory {
  id: string;
  warehouseId: string;
  warehouseName?: string;
  skuId: string;
  skuName: string;
  quantity: number;
  safetyStock: number;
  alertLevel: InventoryAlertLevel;
  updatedAt: string;
}

export interface TransferOrder {
  id: string;
  sourceWarehouseId: string;
  targetWarehouseId: string;
  sourceWarehouseName: string;
  targetWarehouseName: string;
  skuId: string;
  skuName: string;
  quantity: number;
  status: TransferStatus;
  createdBy: string;
  receivedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}
