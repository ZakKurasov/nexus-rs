import { npcAction } from '@server/world/action/npc-action';
import { dialogue, Emote } from '@server/world/actor/dialogue';
import { npcIds } from '@server/world/config/npc-ids';

const talkTo : npcAction = (details) => {
    const { player, npc } = details;
    dialogue([player, { npc, key: 'wilough' }, { npc: npcIds.shilop, key: 'shilop' }], [
        player => [Emote.GENERIC, `Hello again.`],
        wilough => [Emote.GENERIC, `You think you're tough do you?`],
        player => [Emote.GENERIC, `Pardon?`],
        wilough => [Emote.ANGRY, `I can beat anyone up!`],
        shilop => [Emote.BLANK_STARE, `He can you know!`],
        player => [Emote.BLANK_STARE, `Really?`]
    ]);
};

export default {
    npcIds: [npcIds.wilough],
    type: 'npc_action',
    options: ['talk-to'],
    walkTo: true,
    action: talkTo
};
