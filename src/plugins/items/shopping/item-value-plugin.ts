import { itemAction } from '@server/world/action/item-action';
import { widgets } from '@server/world/config/widget';

export const shopSellValueAction: itemAction = (details) => {
    const { player, itemDetails } = details;

    const itemValue = itemDetails.value || 1;

    player.sendMessage(`${itemDetails.name}: currently costs ${itemValue} coins.`);
};

export const shopPurchaseValueAction: itemAction = (details) => {
    const { player } = details;

    player.sendMessage(`Shop purchase value is TBD`);
};

export default [{
    type: 'item_action',
    widgets: widgets.shop,
    options: 'value',
    action: shopSellValueAction,
    cancelOtherActions: false
}, {
    type: 'item_action',
    widgets: widgets.shopPlayerInventory,
    options: 'value',
    action: shopPurchaseValueAction,
    cancelOtherActions: false
}];
