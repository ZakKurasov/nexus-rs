import { buttonAction } from '@server/world/action/button-action';
import { widgets } from '@server/world/config/widget';
import { Player } from '@server/world/actor/player/player';

export function updateBonusStrings(player: Player): void {
    [
        { id: 108, text: 'Stab', value: player.bonuses.offensive.stab },
        { id: 109, text: 'Slash', value: player.bonuses.offensive.slash },
        { id: 110, text: 'Crush', value: player.bonuses.offensive.crush },
        { id: 111, text: 'Magic', value: player.bonuses.offensive.magic },
        { id: 112, text: 'Range', value: player.bonuses.offensive.ranged },
        { id: 113, text: 'Stab', value: player.bonuses.defensive.stab },
        { id: 114, text: 'Slash', value: player.bonuses.defensive.slash },
        { id: 115, text: 'Crush', value: player.bonuses.defensive.crush },
        { id: 116, text: 'Magic', value: player.bonuses.defensive.magic },
        { id: 117, text: 'Range', value: player.bonuses.defensive.ranged },
        { id: 119, text: 'Strength', value: player.bonuses.skill.strength },
        { id: 120, text: 'Prayer', value: player.bonuses.skill.prayer },
    ].forEach(bonus => player.modifyWidget(widgets.equipmentStats.widgetId, { childId: bonus.id,
        text: `${bonus.text}: ${bonus.value > 0 ? `+${bonus.value}` : bonus.value}` }));
}

export const action: buttonAction = (details) => {
    const { player } = details;

    player.updateBonuses();

    updateBonusStrings(player);

    player.outgoingPackets.sendUpdateAllWidgetItems(widgets.equipmentStats, player.equipment);
    player.outgoingPackets.sendUpdateAllWidgetItems(widgets.inventory, player.inventory);

    player.activeWidget = {
        widgetId: widgets.equipmentStats.widgetId,
        secondaryWidgetId: widgets.inventory.widgetId,
        type: 'SCREEN_AND_TAB',
        closeOnWalk: true
    };
};

export default { type: 'button', widgetId: widgets.equipment.widgetId, buttonIds: 24, action };
