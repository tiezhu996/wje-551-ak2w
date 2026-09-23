import { v4 as uuid } from 'uuid';
import { InventoryAlertLevel, TransferStatus } from '../constants/enums.js';
import { inventories, transferOrders, warehouses } from '../database/seeds/initial.js';
import type { Inventory, TransferOrder, User } from '../types/index.js';
import { auditService } from './audit.service.js';
import { BusinessException } from '../utils/response.js';
import { assertPositiveInteger, assertRequired } from '../utils/validation.js';

export function calculateAlertLevel(quantity: number, safetyStock: number) {
  if (quantity <= safetyStock * 0.5) return InventoryAlertLevel.CRITICAL;
  if (quantity <= safetyStock) return InventoryAlertLevel.LOW;
  return InventoryAlertLevel.NORMAL;
}

function nextTransferNo() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `TRF-${date}-${String(transferOrders.length + 1).padStart(4, '0')}`;
}

export class InventoryService {
  warehouses() {
    return warehouses;
  }

  list(query: Record<string, string | undefined>) {
    return inventories
      .filter((item) => !query.warehouseId || item.warehouseId === query.warehouseId)
      .filter((item) => !query.keyword || item.skuId.includes(query.keyword) || item.skuName.includes(query.keyword))
      .filter((item) => !query.alertLevel || item.alertLevel === query.alertLevel);
  }

  findOrCreate(warehouseId: string, skuId: string, skuName: string) {
    let inventory = inventories.find((item) => item.warehouseId === warehouseId && item.skuId === skuId);
    if (!inventory) {
      inventory = { id: uuid(), warehouseId, skuId, skuName, quantity: 0, safetyStock: 20, alertLevel: InventoryAlertLevel.CRITICAL, updatedAt: new Date().toISOString() };
      inventories.push(inventory);
    }
    return inventory;
  }

  inbound(payload: { warehouseId: string; skuId: string; skuName: string; quantity: number }, user?: User) {
    assertRequired(payload.warehouseId, '仓库');
    assertRequired(payload.skuId, 'SKU');
    assertPositiveInteger(Number(payload.quantity), '入库数量');
    const inventory = this.findOrCreate(payload.warehouseId, payload.skuId, payload.skuName);
    inventory.quantity += Number(payload.quantity);
    this.refresh(inventory);
    auditService.record({ action: 'UPDATE', module: 'INVENTORY', targetId: inventory.id, targetName: inventory.skuId, detail: { type: 'INBOUND', quantity: payload.quantity } }, user);
    return inventory;
  }

  outbound(payload: { warehouseId: string; skuId: string; quantity: number }, user?: User) {
    assertPositiveInteger(Number(payload.quantity), '出库数量');
    const inventory = inventories.find((item) => item.warehouseId === payload.warehouseId && item.skuId === payload.skuId);
    if (!inventory) throw new BusinessException(404, '库存不存在');
    if (inventory.quantity < Number(payload.quantity)) throw new BusinessException(400, '出库数量不能超过当前库存');
    inventory.quantity -= Number(payload.quantity);
    this.refresh(inventory);
    auditService.record({ action: 'UPDATE', module: 'INVENTORY', targetId: inventory.id, targetName: inventory.skuId, detail: { type: 'OUTBOUND', quantity: payload.quantity } }, user);
    return inventory;
  }

  listTransfers(query: Record<string, string | undefined>) {
    return transferOrders
      .filter((order) => !query.warehouseId || order.sourceWarehouseId === query.warehouseId || order.targetWarehouseId === query.warehouseId)
      .filter((order) => !query.status || order.status === query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createTransfer(payload: { sourceWarehouseId: string; targetWarehouseId: string; skuId: string; quantity: number }, user?: User) {
    assertRequired(payload.sourceWarehouseId, '源仓库');
    assertRequired(payload.targetWarehouseId, '目标仓库');
    assertRequired(payload.skuId, 'SKU');
    assertPositiveInteger(Number(payload.quantity), '调拨数量');
    if (payload.sourceWarehouseId === payload.targetWarehouseId) throw new BusinessException(400, '源仓库和目标仓库不能相同');
    const sourceWarehouse = warehouses.find((item) => item.id === payload.sourceWarehouseId);
    if (!sourceWarehouse) throw new BusinessException(404, '源仓库不存在');
    const targetWarehouse = warehouses.find((item) => item.id === payload.targetWarehouseId);
    if (!targetWarehouse) throw new BusinessException(404, '目标仓库不存在');
    if (targetWarehouse.status !== 'ACTIVE') throw new BusinessException(400, '目标仓库已停用，无法接收调拨');
    const source = inventories.find((item) => item.warehouseId === payload.sourceWarehouseId && item.skuId === payload.skuId);
    if (!source) throw new BusinessException(404, '源仓库库存不存在');
    if (source.quantity < Number(payload.quantity)) throw new BusinessException(400, '源仓库库存不足，调拨数量不能超过当前库存');
    // 以上校验全部通过后才变更数量，任何失败都不会改动两端库存
    const sourceBefore = source.quantity;
    source.quantity -= Number(payload.quantity);
    this.refresh(source);
    const now = new Date().toISOString();
    const order: TransferOrder = {
      id: uuid(),
      orderNo: nextTransferNo(),
      sourceWarehouseId: payload.sourceWarehouseId,
      targetWarehouseId: payload.targetWarehouseId,
      skuId: source.skuId,
      skuName: source.skuName,
      quantity: Number(payload.quantity),
      status: TransferStatus.IN_TRANSIT,
      createdBy: user?.name ?? '系统',
      createdAt: now,
      updatedAt: now,
    };
    transferOrders.unshift(order);
    auditService.record({ action: 'CREATE', module: 'INVENTORY', targetId: order.id, targetName: order.orderNo, detail: { type: 'TRANSFER_CREATE', order, sourceBefore, sourceAfter: source.quantity } }, user);
    return order;
  }

  receiveTransfer(id: string, user?: User) {
    const order = this.requirePendingTransfer(id, '接收');
    const targetWarehouse = warehouses.find((item) => item.id === order.targetWarehouseId);
    if (!targetWarehouse) throw new BusinessException(404, '目标仓库不存在');
    if (targetWarehouse.status !== 'ACTIVE') throw new BusinessException(400, '目标仓库已停用，无法接收调拨');
    const target = this.findOrCreate(order.targetWarehouseId, order.skuId, order.skuName);
    const targetBefore = target.quantity;
    target.quantity += order.quantity;
    this.refresh(target);
    order.status = TransferStatus.RECEIVED;
    order.receivedBy = user?.name ?? '系统';
    order.receivedAt = new Date().toISOString();
    order.updatedAt = order.receivedAt;
    auditService.record({ action: 'STATUS_CHANGE', module: 'INVENTORY', targetId: order.id, targetName: order.orderNo, detail: { type: 'TRANSFER_RECEIVE', before: TransferStatus.IN_TRANSIT, after: TransferStatus.RECEIVED, targetBefore, targetAfter: target.quantity } }, user);
    return order;
  }

  cancelTransfer(id: string, user?: User) {
    const order = this.requirePendingTransfer(id, '撤销');
    const source = this.findOrCreate(order.sourceWarehouseId, order.skuId, order.skuName);
    const sourceBefore = source.quantity;
    source.quantity += order.quantity;
    this.refresh(source);
    order.status = TransferStatus.CANCELLED;
    order.cancelledBy = user?.name ?? '系统';
    order.cancelledAt = new Date().toISOString();
    order.updatedAt = order.cancelledAt;
    auditService.record({ action: 'STATUS_CHANGE', module: 'INVENTORY', targetId: order.id, targetName: order.orderNo, detail: { type: 'TRANSFER_CANCEL', before: TransferStatus.IN_TRANSIT, after: TransferStatus.CANCELLED, sourceBefore, sourceAfter: source.quantity } }, user);
    return order;
  }

  private requirePendingTransfer(id: string, action: string) {
    const order = transferOrders.find((item) => item.id === id);
    if (!order) throw new BusinessException(404, '调拨单不存在');
    if (order.status !== TransferStatus.IN_TRANSIT) throw new BusinessException(400, `调拨单已${order.status === TransferStatus.RECEIVED ? '接收' : '撤销'}，不能重复${action}，两端库存保持不变`);
    return order;
  }

  check(payload: { warehouseId: string; adjustments: Array<{ skuId: string; actualQuantity: number }> }, user?: User) {
    const report = payload.adjustments.map((adjustment) => {
      const inventory = inventories.find((item) => item.warehouseId === payload.warehouseId && item.skuId === adjustment.skuId);
      if (!inventory) throw new BusinessException(404, `库存${adjustment.skuId}不存在`);
      const before = inventory.quantity;
      inventory.quantity = Number(adjustment.actualQuantity);
      this.refresh(inventory);
      return { skuId: adjustment.skuId, before, after: inventory.quantity, diff: inventory.quantity - before };
    });
    auditService.record({ action: 'UPDATE', module: 'INVENTORY', targetId: payload.warehouseId, targetName: '库存盘点', detail: { type: 'CHECK', report } }, user);
    return report;
  }

  updateSafetyStock(id: string, safetyStock: number, user?: User) {
    const inventory = inventories.find((item) => item.id === id);
    if (!inventory) throw new BusinessException(404, '库存不存在');
    inventory.safetyStock = Number(safetyStock);
    this.refresh(inventory);
    auditService.record({ action: 'UPDATE', module: 'INVENTORY', targetId: id, targetName: inventory.skuId, detail: { safetyStock } }, user);
    return inventory;
  }

  private refresh(inventory: Inventory) {
    inventory.alertLevel = calculateAlertLevel(inventory.quantity, inventory.safetyStock);
    inventory.updatedAt = new Date().toISOString();
  }
}

export const inventoryService = new InventoryService();
