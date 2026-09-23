<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { inventoryApi } from '../api/inventory';
import DataTable from '../components/common/DataTable.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import WarehouseSelector from '../components/common/WarehouseSelector.vue';
import { TransferStatus } from '../constants/enums';
import { PERMISSIONS } from '../constants/permissions';
import { useInventoryStore } from '../stores/inventoryStore';
import type { Inventory, TransferOrder } from '../types/inventory';
import { formatDate } from '../utils/format';

const store = useInventoryStore();
const keyword = ref('');
onMounted(async () => { await store.fetchWarehouses(); await reload(); });
async function reload() {
  await Promise.all([store.fetchInventory({ keyword: keyword.value }), store.fetchTransfers()]);
}
async function inbound(row: any) { await inventoryApi.inbound({ warehouseId: row.warehouseId, skuId: row.skuId, skuName: row.skuName, quantity: 10 }); await reload(); }
async function outbound(row: any) { await inventoryApi.outbound({ warehouseId: row.warehouseId, skuId: row.skuId, quantity: 5 }); await reload(); }

const warehouseName = (id: string) => store.warehouses.find((item) => item.id === id)?.name ?? id;
const toast = (message: string) => window.dispatchEvent(new CustomEvent('app-error', { detail: message }));

const showTransfer = ref(false);
const sourceItems = ref<Inventory[]>([]);
const transferForm = reactive({ sourceWarehouseId: '', targetWarehouseId: '', skuId: '', quantity: 1 });
const selectedSku = computed(() => sourceItems.value.find((item) => item.skuId === transferForm.skuId));
const targetOptions = computed(() => store.warehouses.filter((item) => item.id !== transferForm.sourceWarehouseId && item.status === 'ACTIVE'));

async function openTransfer() {
  transferForm.sourceWarehouseId = store.currentWarehouseId;
  transferForm.targetWarehouseId = '';
  transferForm.skuId = '';
  transferForm.quantity = 1;
  await loadSourceItems();
  showTransfer.value = true;
}
async function loadSourceItems() {
  transferForm.skuId = '';
  sourceItems.value = await inventoryApi.list({ warehouseId: transferForm.sourceWarehouseId }) as unknown as Inventory[];
}
async function submitTransfer() {
  const sku = selectedSku.value;
  if (!transferForm.sourceWarehouseId || !transferForm.targetWarehouseId) return toast('请选择源仓库和目标仓库');
  if (!sku) return toast('请选择要调拨的 SKU');
  if (!Number.isInteger(transferForm.quantity) || transferForm.quantity <= 0) return toast('调拨数量必须为正整数');
  if (transferForm.quantity > sku.quantity) return toast('调拨数量不能超过源仓当前库存');
  await inventoryApi.transfer({ sourceWarehouseId: transferForm.sourceWarehouseId, targetWarehouseId: transferForm.targetWarehouseId, skuId: sku.skuId, skuName: sku.skuName, quantity: transferForm.quantity });
  showTransfer.value = false;
  await reload();
}
async function receiveTransfer(row: TransferOrder) { await inventoryApi.receiveTransfer(row.id); await reload(); }
async function cancelTransfer(row: TransferOrder) { await inventoryApi.cancelTransfer(row.id); await reload(); }
</script>

<template>
  <section>
    <div class="page-title"><h2>库存管理</h2><div><button v-permission="PERMISSIONS.INVENTORY_WRITE" class="btn secondary" @click="openTransfer">调拨</button> <button class="btn secondary">盘点</button></div></div>
    <div class="toolbar">
      <WarehouseSelector v-model="store.currentWarehouseId" @change="reload" />
      <input v-model="keyword" placeholder="SKU 搜索" @input="reload" />
    </div>
    <DataTable :columns="[{key:'skuId',title:'SKU 编码'},{key:'skuName',title:'SKU 名称'},{key:'quantity',title:'当前数量'},{key:'safetyStock',title:'安全库存'},{key:'alertLevel',title:'预警级别'},{key:'updatedAt',title:'最后更新时间'}]" :data="store.inventories as any">
      <template #alertLevel="{ row }"><StatusBadge :value="row.alertLevel" /></template>
      <template #updatedAt="{ row }">{{ formatDate(row.updatedAt) }}</template>
      <template #actions="{ row }">
        <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="inbound(row)">入库+10</button>
        <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="outbound(row)">出库-5</button>
      </template>
    </DataTable>

    <div class="page-title records-title"><h2>调拨记录</h2><small>源仓提交后立即扣减并转为在途，目标仓接收后入库；接收前可撤销</small></div>
    <DataTable :columns="[{key:'orderNo',title:'调拨单号'},{key:'sourceWarehouseId',title:'源仓库'},{key:'targetWarehouseId',title:'目标仓库'},{key:'sku',title:'SKU'},{key:'quantity',title:'数量'},{key:'status',title:'状态'},{key:'createdAt',title:'创建时间'}]" :data="store.transfers as any">
      <template #sourceWarehouseId="{ row }">{{ warehouseName(row.sourceWarehouseId) }}</template>
      <template #targetWarehouseId="{ row }">{{ warehouseName(row.targetWarehouseId) }}</template>
      <template #sku="{ row }">{{ row.skuId }} · {{ row.skuName }}</template>
      <template #status="{ row }"><StatusBadge :value="row.status" kind="transfer" /></template>
      <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>
      <template #actions="{ row }">
        <button v-if="row.status === TransferStatus.IN_TRANSIT" v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="receiveTransfer(row)">接收</button>
        <button v-if="row.status === TransferStatus.IN_TRANSIT" v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="cancelTransfer(row)">撤销</button>
      </template>
    </DataTable>

    <div v-if="showTransfer" class="modal-mask" @click.self="showTransfer = false">
      <div class="modal panel">
        <h3>仓库间调拨</h3>
        <label>源仓库
          <select v-model="transferForm.sourceWarehouseId" @change="loadSourceItems">
            <option v-for="warehouse in store.warehouses" :key="warehouse.id" :value="warehouse.id">{{ warehouse.name }}</option>
          </select>
        </label>
        <label>目标仓库
          <select v-model="transferForm.targetWarehouseId">
            <option value="" disabled>请选择目标仓库</option>
            <option v-for="warehouse in targetOptions" :key="warehouse.id" :value="warehouse.id">{{ warehouse.name }}</option>
          </select>
        </label>
        <label>SKU
          <select v-model="transferForm.skuId">
            <option value="" disabled>请选择 SKU</option>
            <option v-for="item in sourceItems" :key="item.id" :value="item.skuId">{{ item.skuId }} · {{ item.skuName }}（可用 {{ item.quantity }}）</option>
          </select>
        </label>
        <label>数量
          <input v-model.number="transferForm.quantity" type="number" min="1" :max="selectedSku?.quantity" />
        </label>
        <p v-if="selectedSku" class="hint">源仓可用 {{ selectedSku.quantity }}，提交后立即扣减并生成在途调拨单，目标仓接收后才会入库。</p>
        <div class="modal-actions">
          <button class="btn secondary" @click="showTransfer = false">取消</button>
          <button class="btn" @click="submitTransfer">提交调拨</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mini { margin-right:6px; border:0; border-radius:5px; padding:5px 8px; background:#e1e8d0; cursor:pointer; }
.records-title { margin-top:24px; align-items:baseline; }
.records-title small { color:#657068; }
.modal-mask { position:fixed; inset:0; z-index:8; background:rgba(15,25,20,.45); display:flex; align-items:center; justify-content:center; }
.modal { width:420px; display:grid; gap:12px; }
.modal h3 { margin:0; }
.modal label { display:grid; gap:6px; font-size:13px; font-weight:700; color:#3c4a43; }
.modal-actions { display:flex; justify-content:flex-end; gap:10px; }
.hint { margin:0; font-size:12px; color:#657068; }
</style>
