import { widgets } from '@server/world/config/widget';
import { itemAction } from '@server/world/action/item-action';
import { world } from '@server/game-server';
import { soundIds } from '@server/world/config/sound-ids';
import { getItemFromContainer } from '@server/world/items/item-container';

export const action: itemAction = (details) => {
    const { player, itemId, itemSlot } = details;

    const inventory = player.inventory;
    const item = getItemFromContainer(itemId, itemSlot, inventory);

    if(!item) {
        // The specified item was not found in the specified slot.
        return;
    }

    if(player.rights == 2) {
        player.sendMessage('Administrators are not allowed to drop items.', true);
        return;
    }

    inventory.remove(itemSlot);
    player.outgoingPackets.sendUpdateSingleWidgetItem(widgets.inventory, itemSlot, null);
    player.playSound(soundIds.dropItem, 5);
    world.spawnWorldItem(item, player.position, player, 300);
    player.actionsCancelled.next();
};

export default {
    type: 'item_action',
    widgets: widgets.inventory,
    options: 'drop',
    action,
    cancelOtherActions: false
};
