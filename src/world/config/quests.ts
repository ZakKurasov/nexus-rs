import { Action } from '@server/world/action';
import { Player } from '@server/world/actor/player/player';

export interface Quest {
    // The unique ID string for the quest.
    id: string;
    // The child ID of the quest's entry within the quest tab.
    questTabId: number;
    // The formatted name of the quest.
    name: string;
    // How many quest points are awarded upon completion of the quest.
    points: number;
    // The stages that the quest consists of. The given string should be the contents of the quest journal when opened for
    // that specific quest stage. A string or a function returning a string can be provided.
    stages: { [key: string]: ((player?: Player) => void) | string | { color: number, text: string } };
    // Data for what to show on the "Quest Complete" widget.
    completion: {
        rewards: string[];
        onComplete: (player?: Player) => void;
        modelId?: number;
        itemId?: number;
        modelRotationX?: number;
        modelRotationY?: number;
        modelZoom?: number;
    };
}

export interface QuestAction extends Action {
    // The quest being registered.
    quest: Quest;
}

