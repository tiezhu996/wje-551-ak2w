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

  /**
   * 创建仓库间待接收调拨单：提交即从源仓扣减库存，调拨单进入在途状态，
   * 目标仓确认接收后才增加库存。所有校验先于任何数量变更，
   * 源仓不足或目标仓停用时两端数量均不改变。
   */
  createTransfer(payload: { sourceWarehouseId: string; targetWarehouseId: string; skuId: string; quantity: number }, user?: User) {
    assertRequired(payload.sourceWarehouseId, '源仓库');
    assertRequired(payload.targetWarehouseId, '目标仓库');
    assertRequired(payload.skuId, 'SKU');
    assertPositiveInteger(Number(payload.quantity), '调拨数量');
    if (payload.sourceWarehouseId === payload.targetWarehouseId) throw new BusinessException(400, '源仓库与目标仓库不能相同');
    const source = inventories.find((item) => item.warehouseId === payload.sourceWarehouseId && item.skuId === payload.skuId);
    if (!source) throw new BusinessException(404, '源库存不存在');
    const targetWarehouse = warehouses.find((item) => item.id === payload.targetWarehouseId);
    if (!targetWarehouse) throw new BusinessException(404, '目标仓库不存在');
    if (targetWarehouse.status !== 'ACTIVE') throw new BusinessException(400, '目标仓库已停用，无法发起调拨');
    if (source.quantity < Number(payload.quantity)) throw new BusinessException(400, '源仓库存不足，无法调拨');

    const quantity = Number(payload.quantity);
    const before = source.quantity;
    source.quantity -= quantity;
    this.refresh(source);

    const now = new Date().toISOString();
    const order: TransferOrder = {
      id: uuid(),
      sourceWarehouseId: payload.sourceWarehouseId,
      targetWarehouseId: payload.targetWarehouseId,
      skuId: payload.skuId,
      skuName: source.skuName,
      quantity,
      status: TransferStatus.PENDING_RECEIPT,
      createdBy: user?.name ?? '系统',
      createdAt: now,
      updatedAt: now,
    };
    transferOrders.unshift(order);
    auditService.record({
      action: 'CREATE',
      module: 'INVENTORY',
      targetId: order.id,
      targetName: `${source.skuId} 调拨`,
      detail: { type: 'TRANSFER_CREATE', order, sourceQuantity: { before, after: source.quantity } },
    }, user);
    return this.decorate(order);
  }

  /** 目标仓确认接收：校验通过后才增加目标仓库存；重复确认或目标仓停用时两端数量均不变。 */
  receiveTransfer(id: string, user?: User) {
    const order = transferOrders.find((item) => item.id === id);
    if (!order) throw new BusinessException(404, '调拨单不存在');
    if (order.status !== TransferStatus.PENDING_RECEIPT) {
      throw new BusinessException(400, `调拨单${order.status === TransferStatus.RECEIVED ? '已接收，请勿重复确认' : '已取消，无法接收'}`);
    }
    const targetWarehouse = warehouses.find((item) => item.id === order.targetWarehouseId);
    if (!targetWarehouse) throw new BusinessException(404, '目标仓库不存在');
    if (targetWarehouse.status !== 'ACTIVE') throw new BusinessException(400, '目标仓库已停用，无法接收');

    const target = this.findOrCreate(order.targetWarehouseId, order.skuId, order.skuName);
    const before = target.quantity;
    target.quantity += order.quantity;
    this.refresh(target);

    const beforeStatus = order.status;
    const now = new Date().toISOString();
    order.status = TransferStatus.RECEIVED;
    order.receivedAt = now;
    order.updatedAt = now;
    auditService.record({
      action: 'STATUS_CHANGE',
      module: 'INVENTORY',
      targetId: order.id,
      targetName: `${order.skuId} 调拨`,
      detail: { type: 'TRANSFER_RECEIVE', before: beforeStatus, after: order.status, targetQuantity: { before, after: target.quantity } },
    }, user);
    return this.decorate(order);
  }

  /** 源仓在接收前撤销：库存恢复原值；已接收或已撤销的单据不可再改。 */
  cancelTransfer(id: string, user?: User) {
    const order = transferOrders.find((item) => item.id === id);
    if (!order) throw new BusinessException(404, '调拨单不存在');
    if (order.status !== TransferStatus.PENDING_RECEIPT) {
      throw new BusinessException(400, `调拨单${order.status === TransferStatus.RECEIVED ? '已接收，无法撤销' : '已撤销，请勿重复操作'}`);
    }

    const source = this.findOrCreate(order.sourceWarehouseId, order.skuId, order.skuName);
    const before = source.quantity;
    source.quantity += order.quantity;
    this.refresh(source);

    const beforeStatus = order.status;
    const now = new Date().toISOString();
    order.status = TransferStatus.CANCELLED;
    order.cancelledAt = now;
    order.updatedAt = now;
    auditService.record({
      action: 'STATUS_CHANGE',
      module: 'INVENTORY',
      targetId: order.id,
      targetName: `${order.skuId} 调拨`,
      detail: { type: 'TRANSFER_CANCEL', before: beforeStatus, after: order.status, sourceQuantity: { before, after: source.quantity } },
    }, user);
    return this.decorate(order);
  }

  listTransfers(query: Record<string, string | undefined> = {}) {
    return transferOrders
      .filter((item) => !query.warehouseId || item.sourceWarehouseId === query.warehouseId || item.targetWarehouseId === query.warehouseId)
      .filter((item) => !query.status || item.status === query.status)
      .map((item) => this.decorate(item));
  }

  private decorate(order: TransferOrder) {
    return {
      ...order,
      sourceWarehouseName: warehouses.find((item) => item.id === order.sourceWarehouseId)?.name ?? order.sourceWarehouseId,
      targetWarehouseName: warehouses.find((item) => item.id === order.targetWarehouseId)?.name ?? order.targetWarehouseId,
    };
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
