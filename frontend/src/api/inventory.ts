import { request } from './request';
import type { Inventory, TransferOrder, Warehouse } from '../types/inventory';

export const inventoryApi = {
  warehouses: () => request.get<Warehouse[]>('/warehouses'),
  list: (params?: Record<string, string>) => request.get<Inventory[]>('/inventory', { params }),
  transfers: (params?: Record<string, string>) => request.get<TransferOrder[]>('/inventory/transfers', { params }),
  inbound: (payload: unknown) => request.post('/inventory/inbound', payload),
  outbound: (payload: unknown) => request.post('/inventory/outbound', payload),
  transfer: (payload: unknown) => request.post('/inventory/transfer', payload),
  receiveTransfer: (id: string) => request.post(`/inventory/transfers/${id}/receive`),
  cancelTransfer: (id: string) => request.post(`/inventory/transfers/${id}/cancel`),
  check: (payload: unknown) => request.post('/inventory/check', payload),
  safety: (id: string, safetyStock: number) => request.put(`/inventory/${id}/safety-stock`, { safetyStock }),
};
