import { AddressInfo, Socket } from 'net';
import { OutboundPackets } from '@server/net/outbound-packets';
import { Isaac } from '@server/net/isaac';
import { PlayerSyncTask } from './sync/player-sync-task';
import { Actor } from '../actor';
import { Position } from '@server/world/position';
import { cache, pluginActions, serverConfig, world } from '@server/game-server';
import { logger } from '@runejs/core';
import {
    Appearance,
    defaultAppearance, defaultSettings,
    loadPlayerSave, playerExists,
    PlayerSave, PlayerSettings, QuestProgress,
    savePlayerData
} from './player-data';
import { PlayerWidget, widgets, widgetScripts } from '../../config/widget';
import { ContainerUpdateEvent, getItemFromContainer, ItemContainer } from '../../items/item-container';
import { Item } from '../../items/item';
import { Npc } from '../npc/npc';
import { NpcSyncTask } from './sync/npc-sync-task';
import { Observable, Subject } from 'rxjs';
import { Chunk, ChunkUpdateItem } from '@server/world/map/chunk';
import { QuadtreeKey } from '@server/world';
import { daysSinceLastLogin } from '@server/util/time';
import { itemIds } from '@server/world/config/item-ids';
import { dialogueAction } from '@server/world/actor/player/dialogue-action';
import { songs } from '@server/world/config/songs';
import { colors, hexToRgb, rgbTo16Bit } from '@server/util/colors';
import { ItemDefinition } from '@runejs/cache-parser';
import { PlayerCommandAction } from '@server/world/action/player-command-action';
import { take } from 'rxjs/operators';
import { updateBonusStrings } from '@server/plugins/items/equipment/equipment-stats-plugin';
import { Action, actionHandler } from '@server/world/action';
import {
    DefensiveBonuses,
    equipmentIndex,
    EquipmentSlot, getEquipmentSlot,
    ItemDetails,
    OffensiveBonuses, SkillBonuses
} from '@server/config/item-config';
import { findItem, npcIdMap } from '@server/config';
import { NpcDetails } from '@server/config/npc-config';

export const playerOptions: { option: string, index: number, placement: 'TOP' | 'BOTTOM' }[] = [
    {
        option: 'Yeet',
        index: 1,
        placement: 'TOP'
    },
    {
        option: 'Follow',
        index: 0,
        placement: 'BOTTOM'
    }
];

export const defaultPlayerTabWidgets = [
    widgets.defaultCombatStyle, widgets.skillsTab, widgets.questTab, widgets.inventory.widgetId,
    widgets.equipment.widgetId, widgets.prayerTab, widgets.standardSpellbookTab, null,
    widgets.friendsList, widgets.ignoreList, widgets.logoutTab, widgets.settingsTab, widgets.emotesTab,
    widgets.musicPlayerTab
];

export enum Tabs {
    combatStyle = 0,
    skills = 1,
    quests = 2,
    inventory = 3,
    equipment = 4,
    prayers = 5,
    magic = 6,
    friends = 8,
    ignoreList = 9,
    logout = 10,
    settings = 11,
    emotes = 12,
    music = 13
}

export enum Rights {
    ADMIN = 2,
    MOD = 1,
    USER = 0
}

export type playerInitAction = (data: { player: Player }) => void;

export interface PlayerInitAction extends Action {
    // The action function to be performed.
    action: playerInitAction;
}

/**
 * A player character within the game world.
 */
export class Player extends Actor {

    public readonly clientUuid: number;
    public readonly username: string;
    public readonly passwordHash: string;
    public readonly playerUpdateTask: PlayerSyncTask;
    public readonly npcUpdateTask: NpcSyncTask;
    public readonly numericInputEvent: Subject<number>;
    public readonly dialogueInteractionEvent: Subject<number>;
    public isLowDetail: boolean;
    public trackedPlayers: Player[];
    public trackedNpcs: Npc[];
    public savedMetadata: { [key: string]: any } = {};
    public sessionMetadata: { [key: string]: any } = {};
    public quests: QuestProgress[] = [];
    public achievements: string[] = [];
    public friendsList: string[] = [];
    public ignoreList: string[] = [];

    private readonly _socket: Socket;
    private readonly _inCipher: Isaac;
    private readonly _outCipher: Isaac;
    private readonly _outgoingPackets: OutboundPackets;
    private readonly _equipment: ItemContainer;
    private _rights: Rights;
    private loggedIn: boolean;
    private _loginDate: Date;
    private _lastAddress: string;
    private firstTimePlayer: boolean;
    private _appearance: Appearance;
    private _activeWidget: PlayerWidget;
    private queuedWidgets: PlayerWidget[];
    private _bonuses: { offensive: OffensiveBonuses, defensive: DefensiveBonuses, skill: SkillBonuses };
    private _carryWeight: number;
    private _settings: PlayerSettings;
    private _walkingTo: Position;
    private _nearbyChunks: Chunk[];
    private quadtreeKey: QuadtreeKey = null;
    private privateMessageIndex: number = 1;

    public constructor(socket: Socket, inCipher: Isaac, outCipher: Isaac, clientUuid: number, username: string, password: string, isLowDetail: boolean) {
        super();

        this._socket = socket;
        this._inCipher = inCipher;
        this._outCipher = outCipher;
        this.clientUuid = clientUuid;
        this.username = username;
        this.passwordHash = password;
        this._rights = Rights.ADMIN;
        this.isLowDetail = isLowDetail;
        this._outgoingPackets = new OutboundPackets(this);
        this.playerUpdateTask = new PlayerSyncTask(this);
        this.npcUpdateTask = new NpcSyncTask(this);
        this.trackedPlayers = [];
        this.trackedNpcs = [];
        this._activeWidget = null;
        this.queuedWidgets = [];
        this._carryWeight = 0;
        this._equipment = new ItemContainer(14);
        this.dialogueInteractionEvent = new Subject<number>();
        this.numericInputEvent = new Subject<number>();
        this._nearbyChunks = [];
        this.friendsList = [];
        this.ignoreList = [];

        this.loadSaveData();
    }

    public init(): void {
        this.loggedIn = true;
        this.updateFlags.mapRegionUpdateRequired = true;
        this.updateFlags.appearanceUpdateRequired = true;

        const playerChunk = world.chunkManager.getChunkForWorldPosition(this.position);
        playerChunk.addPlayer(this);

        this.outgoingPackets.updateCurrentMapChunk();
        this.chunkChanged(playerChunk);
        this.outgoingPackets.chatboxMessage('Welcome to RuneJS.');

        this.skills.values.forEach((skill, index) =>
            this.outgoingPackets.updateSkill(index, skill.level, skill.exp));

        this.outgoingPackets.sendUpdateAllWidgetItems(widgets.inventory, this.inventory);
        this.outgoingPackets.sendUpdateAllWidgetItems(widgets.equipment, this.equipment);
        for(const item of this.equipment.items) {
            if(item) {
                actionHandler.call('equip_action', this, item.itemId, 'EQUIP');
            }
        }

        if(this.firstTimePlayer) {
            if(!serverConfig.tutorialEnabled) {
                this.openInteractiveWidget({
                    widgetId: widgets.characterDesign,
                    type: 'SCREEN',
                    disablePlayerMovement: true
                }).toPromise();
            }
        } else if(serverConfig.showWelcome && this.savedMetadata.tutorialComplete) {
            const daysSinceLogin = daysSinceLastLogin(this.loginDate);
            let loginDaysStr = '';

            if(daysSinceLogin <= 0) {
                loginDaysStr = 'earlier today';
            } else if(daysSinceLogin === 1) {
                loginDaysStr = 'yesterday';
            } else {
                loginDaysStr = daysSinceLogin + ' days ago';
            }
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreenChildren.question, 1, `Want to help RuneJS improve?\\nSend us a pull request over on Github!`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 13, `You last logged in @red@${ loginDaysStr }@bla@ from: @red@${ this.lastAddress }`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 16, `You have @yel@0 unread messages\\nin your message centre.`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 14, `\\nYou have not yet set any recovery questions.\\nIt is @lre@strongly@yel@ recommended that you do so.\\n\\nIf you don't you will be @lre@unable to recover your\\n@lre@password@yel@ if you forget it, or it is stolen.`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 22, `To change your recovery questions:\\n1) Logout and return to the frontpage of this website.\\n2) Choose 'Set new recovery questions'.`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 17, `\\nYou do not have a Bank PIN.\\nPlease visit a bank if you would like one.`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 21, `To start a subscripton:\\n1) Logout and return to the frontpage of this website.\\n2) Choose 'Start a new subscription'`);
            this.outgoingPackets.updateWidgetString(widgets.welcomeScreen, 19, `You are not a member.\\n\\nChoose to subscribe and\\nyou'll get loads of extra\\nbenefits and features.`);

            this.activeWidget = {
                widgetId: widgets.welcomeScreen,
                secondaryWidgetId: widgets.welcomeScreenChildren.question,
                type: 'FULLSCREEN'
            };
        }

        for(const playerOption of playerOptions) {
            this.outgoingPackets.updatePlayerOption(playerOption.option, playerOption.index, playerOption.placement);
        }

        this.updateBonuses();
        this.updateCarryWeight(true);
        this.modifyWidget(widgets.musicPlayerTab, { childId: 82, textColor: colors.green }); // Set "Harmony" to green/unlocked on the music tab
        this.playSong(songs.harmony);
        this.updateQuestTab();

        this.inventory.containerUpdated.subscribe(event => this.inventoryUpdated(event));

        this.actionsCancelled.subscribe(type => {
            let closeWidget = false;

            const widget = this.activeWidget;

            if(widget && !widget.permanent) {
                if(type === 'manual-movement' || type === 'pathing-movement') {
                    if(widget.closeOnWalk) {
                        closeWidget = true;
                    }
                } else if(type === 'keep-widgets-open' || type === 'button' || type === 'widget') {
                    closeWidget = false;
                } else {
                    closeWidget = true;
                }
            }

            if(closeWidget) {
                widget.closed.next();
                widget.closed.complete();

                if(widget.forceClosed !== undefined) {
                    widget.forceClosed();
                }

                this.outgoingPackets.closeActiveWidgets();
                this._activeWidget = null;
            }
        });

        this._loginDate = new Date();
        this._lastAddress = (this._socket?.address() as AddressInfo)?.address || '127.0.0.1';

        if(this.rights === Rights.ADMIN) {
            this.sendCommandList(pluginActions.player_command);
        }

        new Promise(resolve => {
            pluginActions.player_init.forEach(plugin => plugin.action({ player: this }));
            resolve();
        }).then(() => {
            this.outgoingPackets.flushQueue();
            logger.info(`${ this.username }:${ this.worldIndex } has logged in.`);
        });
    }

    public logout(): void {
        if(!this.loggedIn) {
            return;
        }

        world.playerTree.remove(this.quadtreeKey);
        this.save();

        this.actionsCancelled.complete();
        this.movementEvent.complete();
        this.outgoingPackets.logout();
        world.chunkManager.getChunkForWorldPosition(this.position).removePlayer(this);
        world.deregisterPlayer(this);

        this.loggedIn = false;
        logger.info(`${ this.username } has logged out.`);
    }

    public save(): void {
        savePlayerData(this);
    }

    public privateMessageReceived(fromPlayer: Player, messageBytes: number[]): void {
        this.outgoingPackets.sendPrivateMessage(this.privateMessageIndex++, fromPlayer, messageBytes);
    }

    public addFriend(friendName: string): boolean {
        if(!playerExists(friendName)) {
            return false;
        }

        friendName = friendName.toLowerCase();
        this.friendsList.push(friendName);
        return true;
    }

    public removeFriend(friendName: string): boolean {
        friendName = friendName.toLowerCase();
        const index = this.friendsList.findIndex(friend => friend === friendName);
        if(index === -1) {
            return false;
        }

        this.friendsList.splice(index, 1);
        return true;
    }

    public addIgnoredPlayer(playerName: string): boolean {
        if(!playerExists(playerName)) {
            return false;
        }

        playerName = playerName.toLowerCase();
        // @TODO emit event to friend service watcher
        return this.ignoreList.findIndex(ignoredPlayer => ignoredPlayer === playerName) === -1;
    }

    public removeIgnoredPlayer(playerName: string): boolean {
        playerName = playerName.toLowerCase();
        const index = this.ignoreList.findIndex(ignoredPlayer => ignoredPlayer === playerName);
        if(index === -1) {
            return false;
        }

        // @TODO emit event to friend service watcher
        this.ignoreList.splice(index, 1);
        return true;
    }

    public openInteractiveWidget(widget: PlayerWidget): Observable<number> {
        const subject = new Subject<number>();
        this.activeWidget = widget;

        this.actionsCancelled.pipe(take(1)).subscribe(() => {
            subject.next(-1);
            subject.complete();
        });

        this.metadata.buttonListener = {
            widgetId: widget.widgetId,
            event: new Subject<number>()
        };

        this.metadata.buttonListener.event.pipe(take(1)).subscribe(buttonId => {
            delete this.metadata.buttonListener;
            subject.next(buttonId);
            subject.complete();
        });

        return subject.asObservable();
    }

    /**
     * Should be fired whenever the player's chunk changes. This will fire off chunk updates for all chunks not
     * already tracked by the player - all the new chunks that are coming into view.
     * @param chunk The player's new active map chunk.
     */
    public chunkChanged(chunk: Chunk): void {
        const nearbyChunks = world.chunkManager.getSurroundingChunks(chunk);
        if(this._nearbyChunks.length === 0) {
            this.sendChunkUpdates(nearbyChunks);
        } else {
            const newChunks = nearbyChunks.filter(c1 => this._nearbyChunks.findIndex(c2 => c1.equals(c2)) === -1);
            this.sendChunkUpdates(newChunks);
        }

        this._nearbyChunks = nearbyChunks;
    }

    public async tick(): Promise<void> {
        return new Promise<void>(resolve => {
            this.walkingQueue.process();

            if(this.updateFlags.mapRegionUpdateRequired) {
                this.outgoingPackets.updateCurrentMapChunk();
            }

            resolve();
        });
    }

    public async update(): Promise<void> {
        await Promise.all([ this.playerUpdateTask.execute(), this.npcUpdateTask.execute() ]);
    }

    public async reset(): Promise<void> {
        return new Promise<void>(resolve => {
            this.updateFlags.reset();

            this.outgoingPackets.flushQueue();

            if(this.metadata['updateChunk']) {
                const { newChunk, oldChunk } = this.metadata['updateChunk'];
                oldChunk.removePlayer(this);
                newChunk.addPlayer(this);
                this.chunkChanged(newChunk);
                this.metadata['updateChunk'] = null;
            }

            if(this.metadata['teleporting']) {
                this.metadata['teleporting'] = null;
            }

            resolve();
        });
    }

    /**
     * Fetches the player's number of quest points based off of their completed quests.
     */
    public getQuestPoints(): number {
        let questPoints = 0;

        if(this.quests && this.quests.length !== 0) {
            this.quests.filter(quest => quest.stage === 'COMPLETE')
                .forEach(quest => questPoints += pluginActions.quest[quest.questId].points);
        }

        return questPoints;
    }

    /**
     * Fetches a player's quest progression details.
     * @param questId The ID of the quest to find the player's status on.
     */
    public getQuest(questId: string): QuestProgress {
        let playerQuest = this.quests.find(quest => quest.questId === questId);
        if(!playerQuest) {
            playerQuest = {
                questId,
                stage: 'NOT_STARTED',
                attributes: {}
            };

            this.quests.push(playerQuest);
        }

        return playerQuest;
    }

    /**
     * Sets a player's quest stage to the specified value.
     * @param questId The ID of the quest to set the stage of.
     * @param stage The stage to set the quest to.
     */
    public setQuestStage(questId: string, stage: string): void {
        const questData = pluginActions.quest[questId];

        let playerQuest = this.quests.find(quest => quest.questId === questId);
        if(!playerQuest) {
            playerQuest = {
                questId,
                stage: 'NOT_STARTED',
                attributes: {}
            };

            this.quests.push(playerQuest);
        }

        if(playerQuest.stage === 'NOT_STARTED' && stage !== 'COMPLETE') {
            this.modifyWidget(widgets.questTab, { childId: questData.questTabId, textColor: colors.yellow });
        } else if(playerQuest.stage !== 'COMPLETE' && stage === 'COMPLETE') {
            this.outgoingPackets.updateClientConfig(widgetScripts.questPoints, questData.points + this.getQuestPoints());
            this.modifyWidget(widgets.questReward, { childId: 2, text: `You have completed ${ questData.name }!` });
            this.modifyWidget(widgets.questReward, {
                childId: 8,
                text: `${ questData.points } Quest Point${ questData.points > 1 ? 's' : '' }`
            });

            for(let i = 0; i < 5; i++) {
                if(i >= questData.completion.rewards.length) {
                    this.modifyWidget(widgets.questReward, { childId: 9 + i, text: '' });
                } else {
                    this.modifyWidget(widgets.questReward, { childId: 9 + i, text: questData.completion.rewards[i] });
                }
            }

            if(questData.completion.itemId) {
                this.outgoingPackets.updateWidgetModel1(widgets.questReward, 3,
                    (cache.itemDefinitions.get(questData.completion.itemId) as ItemDefinition).inventoryModelId);
            } else if(questData.completion.modelId) {
                this.outgoingPackets.updateWidgetModel1(widgets.questReward, 3, questData.completion.modelId);
            }

            this.outgoingPackets.setWidgetModelRotationAndZoom(widgets.questReward, 3,
                questData.completion.modelRotationX || 0, questData.completion.modelRotationY || 0,
                questData.completion.modelZoom || 0);

            this.activeWidget = {
                widgetId: widgets.questReward,
                type: 'SCREEN',
                closeOnWalk: true
            };

            this.modifyWidget(widgets.questTab, { childId: questData.questTabId, textColor: colors.green });

            questData.completion.onComplete(this);
        }

        playerQuest.stage = stage;
    }

    /**
     * Modifies the specified widget using the provided options.
     * @param widgetId The widget id of the widget to modify.
     * @param options The options with which to modify the widget.
     */
    public modifyWidget(widgetId: number, options: { childId?: number, text?: string, hidden?: boolean, textColor?: number }): void {
        const { childId, text, hidden, textColor } = options;

        if(childId !== undefined) {
            if(text !== undefined) {
                this.outgoingPackets.updateWidgetString(widgetId, childId, text);
            }
            if(hidden !== undefined) {
                this.outgoingPackets.toggleWidgetVisibility(widgets.skillGuide, childId, hidden);
            }
            if(textColor !== undefined) {
                const { r, g, b } = hexToRgb(textColor);
                this.outgoingPackets.updateWidgetColor(widgetId, childId, rgbTo16Bit(r, g, b));
            }
        }
    }

    /**
     * Sets the player's specified sidebar widget to the given widget id.
     * @param sidebarId The sidebar to change.
     * @param widgetId The widget to insert into the sidebar.
     */
    public setSidebarWidget(sidebarId: number, widgetId: number): void {
        this.outgoingPackets.sendTabWidget(sidebarId, widgetId || null);
    }

    /**
     * Plays the given song for the player.
     * @param songId The id of the song to play.
     */
    public playSong(songId: number): void {
        this.outgoingPackets.playSong(songId);
    }

    /**
     * Plays a sound for this specific player.
     * @param soundId The id of the sound effect.
     * @param volume The volume to play the sound at; defaults to 10 (max).
     * @param delay The delay after which to play the sound; defaults to 0 (no delay).
     */
    public playSound(soundId: number, volume: number = 10, delay: number = 0): void {
        this.outgoingPackets.playSound(soundId, volume, delay);
    }

    /**
     * Sends a message to the player via the chatbox.
     * @param messages The single message or array of lines to send to the player.
     * @param showDialogue Whether or not to show the message in a "Click to continue" dialogue.
     * @returns A Promise<void> that resolves when the player has clicked the "click to continue" button or
     * after their chat messages have been sent.
     */
    public async sendMessage(messages: string | string[], showDialogue: boolean = false): Promise<void> {
        if(!Array.isArray(messages)) {
            messages = [ messages ];
        }

        if(!showDialogue) {
            messages.forEach(message => this.outgoingPackets.chatboxMessage(message));
            return Promise.resolve();
        } else {
            if(messages.length > 5) {
                throw new Error(`Dialogues have a maximum of 5 lines!`);
            }

            return dialogueAction(this, { type: 'TEXT', lines: messages }).then(async d => {
                d.close();
                return Promise.resolve();
            });
        }
    }

    /**
     * Instantly teleports the player to the specified location.
     * @param newPosition The player's new position.
     */
    public teleport(newPosition: Position): void {
        const oldChunk = world.chunkManager.getChunkForWorldPosition(this.position);
        const newChunk = world.chunkManager.getChunkForWorldPosition(newPosition);

        this.walkingQueue.clear();
        this.position = newPosition;

        this.updateFlags.mapRegionUpdateRequired = true;
        this.lastMapRegionUpdatePosition = newPosition;
        this.metadata['teleporting'] = true;

        if(!oldChunk.equals(newChunk)) {
            this.metadata['updateChunk'] = { newChunk, oldChunk };
        }
    }

    public canMove(): boolean {
        return true;
    }

    public removeFirstItem(item: number | Item): number {
        const slot = this.inventory.removeFirst(item);

        if(slot === -1) {
            return -1;
        }

        this.outgoingPackets.sendUpdateSingleWidgetItem(widgets.inventory, slot, null);
        return slot;
    }

    public hasCoins(amount: number): number {
        return this.inventory.items
            .findIndex(item => item !== null && item.itemId === itemIds.coins && item.amount >= amount);
    }

    public removeItem(slot: number): void {
        this.inventory.remove(slot);
        this.outgoingPackets.sendUpdateSingleWidgetItem(widgets.inventory, slot, null);
    }

    public giveItem(item: number | Item): boolean {
        const addedItem = this.inventory.add(item);
        if(addedItem === null) {
            return false;
        }

        this.outgoingPackets.sendUpdateSingleWidgetItem(widgets.inventory, addedItem.slot, addedItem.item);
        return true;
    }

    public hasItemOnPerson(item: number | Item): boolean {
        return this.hasItemInInventory(item) || this.isItemEquipped(item);
    }

    /**
     * Updates the player's carry weight based off of their held items (inventory + equipment).
     * @param force Whether or not to force send an updated carry weight to the game client.
     */
    public updateCarryWeight(force: boolean = false): void {
        const oldWeight = this._carryWeight;
        this._carryWeight = Math.round(this.inventory.weight() + this.equipment.weight());

        if(oldWeight !== this._carryWeight || force) {
            this.outgoingPackets.updateCarryWeight(this._carryWeight);
        }
    }

    /**
     * Updates a player's client settings based off of which setting button they've clicked.
     * @param buttonId The ID of the setting button.
     * @TODO refactor to better match the 400+ widget system
     */
    public settingChanged(buttonId: number): void {
        const settingsMappings = {
            0: { setting: 'runEnabled', value: !this.settings['runEnabled'] },
            1: { setting: 'chatEffectsEnabled', value: !this.settings['chatEffectsEnabled'] },
            2: { setting: 'splitPrivateChatEnabled', value: !this.settings['splitPrivateChatEnabled'] },
            3: { setting: 'twoMouseButtonsEnabled', value: !this.settings['twoMouseButtonsEnabled'] },
            4: { setting: 'acceptAidEnabled', value: !this.settings['acceptAidEnabled'] },
            // 5 is house options
            // 6 is unknown, might not even exist
            7: { setting: 'screenBrightness', value: 1 },
            8: { setting: 'screenBrightness', value: 2 },
            9: { setting: 'screenBrightness', value: 3 },
            10: { setting: 'screenBrightness', value: 4 },
            11: { setting: 'musicVolume', value: 4 },
            12: { setting: 'musicVolume', value: 3 },
            13: { setting: 'musicVolume', value: 2 },
            14: { setting: 'musicVolume', value: 1 },
            15: { setting: 'musicVolume', value: 0 },
            16: { setting: 'soundEffectVolume', value: 4 },
            17: { setting: 'soundEffectVolume', value: 3 },
            18: { setting: 'soundEffectVolume', value: 2 },
            19: { setting: 'soundEffectVolume', value: 1 },
            20: { setting: 'soundEffectVolume', value: 0 },
            29: { setting: 'areaEffectVolume', value: 4 },
            30: { setting: 'areaEffectVolume', value: 3 },
            31: { setting: 'areaEffectVolume', value: 2 },
            32: { setting: 'areaEffectVolume', value: 1 },
            33: { setting: 'areaEffectVolume', value: 0 },
            // 150: {setting: 'autoRetaliateEnabled', value: true},
            // 151: {setting: 'autoRetaliateEnabled', value: false}
        };

        if(!settingsMappings[buttonId]) {
            return;
        }

        const config = settingsMappings[buttonId];
        this.settings[config.setting] = config.value;
    }

    /**
     * Updates the player's combat bonuses based off of their equipped items.
     */
    public updateBonuses(): void {
        this.clearBonuses();

        for(const item of this._equipment.items) {
            if(item === null) {
                continue;
            }

            this.addBonuses(item);
        }
    }

    /**
     * Queues up a widget to be displayed when the active widget is closed.
     * If there is no active widget, the provided widget will be automatically displayed.
     * @param widget The widget to queue.
     */
    public queueWidget(widget: PlayerWidget): void {
        if(this.activeWidget === null) {
            this.activeWidget = widget;
        } else {
            this.queuedWidgets.push(widget);
        }
    }

    public sendLogMessage(message: string, isConsole: boolean): void {
        if(isConsole) {
            this.outgoingPackets.consoleMessage(message);
        } else {
            this.outgoingPackets.chatboxMessage(message);
        }
    }

    public sendCommandList(commands: PlayerCommandAction[]): void {
        for(const command of commands) {
            let strCmd: string;
            if(Array.isArray(command.commands)) {
                strCmd = command.commands.join('|');
            } else {
                strCmd = command.commands;
            }
            let strHelp: string = '';
            if(command.args) {
                for(const arg of command.args) {
                    if(arg.defaultValue) {
                        strHelp = `${ strHelp } \\<${ arg.name } = ${ arg.defaultValue }>`;
                    } else {
                        strHelp = `${ strHelp } \\<${ arg.name }>`;
                    }
                }
            }
            this.outgoingPackets.sendConsoleCommand(strCmd, strHelp);
        }
    }

    /**
     * Closes the currently active widget or widget pair.
     * @param notifyClient [optional] Whether or not to notify the game client that widgets should be cleared. Defaults to true.
     */
    public closeActiveWidgets(notifyClient: boolean = true): void {
        if(notifyClient) {
            if(this.queuedWidgets.length !== 0) {
                this.activeWidget = this.queuedWidgets.shift();
            } else {
                this.activeWidget = null;
            }
        } else {
            this._activeWidget = null;

            if(this.queuedWidgets.length !== 0) {
                this.activeWidget = this.queuedWidgets.shift();
            } else {
                this.actionsCancelled.next('keep-widgets-open');
            }
        }
    }

    /**
     * Checks to see if the player has the specified widget ID open on their screen or not.
     * @param widgetId The ID of the widget to look for.
     */
    public hasWidgetOpen(widgetId: number): boolean {
        return this.activeWidget && this.activeWidget.widgetId === widgetId;
    }

    public isItemEquipped(item: number | Item): boolean {
        return this._equipment.has(item);
    }

    public getEquippedItem(equipmentSlot: EquipmentSlot): Item | null {
        return this.equipment.items[equipmentIndex(equipmentSlot)] || null;
    }

    public equipItem(itemId: number, itemSlot: number, slot: EquipmentSlot | number): boolean {
        const itemToEquip = getItemFromContainer(itemId, itemSlot, this.inventory);

        if(!itemToEquip) {
            // The specified item was not found in the specified slot.
            return false;
        }

        let slotIndex: number;
        if(typeof slot === 'number') {
            slotIndex = slot;
            slot = getEquipmentSlot(slotIndex);
        } else {
            slotIndex = equipmentIndex(slot);
        }

        const itemToUnequip: Item = this.equipment.items[slotIndex];
        let shouldUnequipOffHand: boolean = false;
        let shouldUnequipMainHand: boolean = false;
        const itemDetails: ItemDetails = findItem(itemId);

        if(!itemDetails || !itemDetails.equipmentData || !itemDetails.equipmentData.equipmentSlot) {
            this.sendMessage(`Unable to equip item ${ itemId }/${ itemDetails.name }: Missing equipment data.`);
            return;
        }

        if(itemDetails && itemDetails.equipmentData) {
            if(itemDetails.equipmentData.equipmentType === 'two_handed') {
                shouldUnequipOffHand = true;
            }

            if(slot === 'off_hand' && this.getEquippedItem('main_hand')) {
                const mainHandItemData: ItemDetails = findItem(this.getEquippedItem('main_hand').itemId);

                if(mainHandItemData && mainHandItemData.equipmentData && mainHandItemData.equipmentData.equipmentType === 'two_handed') {
                    shouldUnequipMainHand = true;
                }
            }
        }

        if(itemToUnequip) {
            if(shouldUnequipOffHand && !this.unequipItem('off_hand', false)) {
                return false;
            }

            if(shouldUnequipMainHand && !this.unequipItem('main_hand', false)) {
                return false;
            }

            actionHandler.call('equip_action', this, itemToUnequip.itemId, 'UNEQUIP', slot);

            this.equipment.remove(slotIndex, false);
            this.inventory.remove(itemSlot, false);

            this.equipment.set(slotIndex, itemToEquip);
            this.inventory.set(itemSlot, itemToUnequip);

        } else {
            this.equipment.set(slotIndex, itemToEquip);
            this.inventory.remove(itemSlot);

            if(shouldUnequipOffHand) {
                this.unequipItem('off_hand');
            }

            if(shouldUnequipMainHand) {
                this.unequipItem('main_hand');
            }
        }

        actionHandler.call('equip_action', this, itemId, 'EQUIP', slot);
        this.equipmentChanged();
        return true;
    }

    public equipmentChanged(): void {
        this.updateBonuses();

        // @TODO change packets to only update modified container slots
        this.outgoingPackets.sendUpdateAllWidgetItems(widgets.inventory, this.inventory);
        this.outgoingPackets.sendUpdateAllWidgetItems(widgets.equipment, this.equipment);

        if(this.hasWidgetOpen(widgets.equipmentStats.widgetId)) {
            this.outgoingPackets.sendUpdateAllWidgetItems(widgets.equipmentStats, this.equipment);
            updateBonusStrings(this);
        }

        this.updateFlags.appearanceUpdateRequired = true;
    }

    public unequipItem(slot: EquipmentSlot | number, updateRequired: boolean = true): boolean {
        const inventorySlot = this.inventory.getFirstOpenSlot();
        if(inventorySlot === -1) {
            this.sendMessage(`You don't have enough free space to do that.`);
            return false;
        }

        let slotIndex: number;
        if(typeof slot === 'number') {
            slotIndex = slot;
            slot = getEquipmentSlot(slotIndex);
        } else {
            slotIndex = equipmentIndex(slot);
        }

        const itemInSlot = this.equipment.items[slotIndex];

        if(!itemInSlot) {
            return true;
        }

        actionHandler.call('equip_action', this, itemInSlot.itemId, 'UNEQUIP', slot);

        this.equipment.remove(slotIndex);
        this.inventory.set(inventorySlot, itemInSlot);
        if(updateRequired) {
            this.equipmentChanged();
        }
        return true;
    }

    /**
     * Transform's the player's appearance into the specified NPC.
     * @param npc The NPC to copy the appearance of.
     */
    public transformInto(npc: Npc | NpcDetails | string | number): void {
        if(!npc) {
            delete this.savedMetadata.npcTransformation;
            this.updateFlags.appearanceUpdateRequired = true;
            return;
        }

        if(typeof npc !== 'number') {
            if(typeof npc === 'string') {
                if(npc.indexOf(':') !== -1) {
                    npc = npcIdMap[npc];
                } else {
                    npc = parseInt(npc, 10);
                }
            } else if(npc instanceof Npc) {
                npc = npc.id;
            } else {
                npc = npc.gameId;
            }
        }

        if(!npc) {
            logger.error(`NPC not found.`);
            return;
        }

        this.savedMetadata.npcTransformation = npc;
        this.updateFlags.appearanceUpdateRequired = true;
    }

    public equals(player: Player): boolean {
        return this.worldIndex === player.worldIndex && this.username === player.username && this.clientUuid === player.clientUuid;
    }

    private inventoryUpdated(event: ContainerUpdateEvent): void {
        if(event.type === 'CLEAR_ALL') {
            this.outgoingPackets.sendUpdateAllWidgetItems(widgets.inventory, this.inventory);
        }
        this.updateCarryWeight();
    }

    /**
     * Sends chunk updates to notify the client of added & removed location objects
     * @param chunks The chunks to update.
     */
    private sendChunkUpdates(chunks: Chunk[]): void {
        chunks.forEach(chunk => {
            this.outgoingPackets.clearChunk(chunk);

            const chunkUpdateItems: ChunkUpdateItem[] = [];

            if(chunk.removedLocationObjects.size !== 0) {
                chunk.removedLocationObjects.forEach(object => chunkUpdateItems.push({ object, type: 'REMOVE' }));
            }

            if(chunk.addedLocationObjects.size !== 0) {
                chunk.addedLocationObjects.forEach(object => chunkUpdateItems.push({ object, type: 'ADD' }));
            }

            if(chunk.worldItems.size !== 0) {
                chunk.worldItems.forEach(worldItemList => {
                    if(worldItemList && worldItemList.length !== 0) {
                        worldItemList.forEach(worldItem => {
                            if(!worldItem.initiallyVisibleTo || worldItem.initiallyVisibleTo.equals(this)) {
                                chunkUpdateItems.push({ worldItem, type: 'ADD' });
                            }
                        });
                    }
                });
            }

            if(chunkUpdateItems.length !== 0) {
                this.outgoingPackets.updateChunk(chunk, chunkUpdateItems);
            }
        });
    }

    /**
     * Updates the player's quest tab progress.
     */
    private updateQuestTab(): void {
        this.outgoingPackets.updateClientConfig(widgetScripts.questPoints, this.getQuestPoints());

        const questMap = pluginActions.quest;
        if(!questMap) {
            return;
        }
        Object.keys(questMap).forEach(questKey => {
            const questData = questMap[questKey];
            const playerQuest = this.quests.find(quest => quest.questId === questData.id);
            let stage = 'NOT_STARTED';
            let color = colors.red;
            if(playerQuest && playerQuest.stage) {
                stage = playerQuest.stage;
                color = stage === 'COMPLETE' ? colors.green : colors.yellow;
            }

            this.modifyWidget(widgets.questTab, { childId: questData.questTabId, textColor: color });
        });
    }

    private addBonuses(item: Item): void {
        const itemData: ItemDetails = findItem(item.itemId);

        if(!itemData || !itemData.equipmentData) {
            return;
        }

        const offensiveBonuses = itemData.equipmentData.offensiveBonuses;
        const defensiveBonuses = itemData.equipmentData.defensiveBonuses;
        const skillBonuses = itemData.equipmentData.skillBonuses;

        if(offensiveBonuses) {
            [ 'speed', 'stab', 'slash', 'crush', 'magic', 'ranged' ].forEach(bonus => this._bonuses.offensive[bonus] += (!offensiveBonuses[bonus] ? 0 : offensiveBonuses[bonus]));
        }

        if(defensiveBonuses) {
            [ 'stab', 'slash', 'crush', 'magic', 'ranged' ].forEach(bonus => this._bonuses.defensive[bonus] += (!defensiveBonuses[bonus] ? 0 : defensiveBonuses[bonus]));
        }

        if(skillBonuses) {
            [ 'strength', 'prayer' ].forEach(bonus => this._bonuses.skill[bonus] += (!skillBonuses[bonus] ? 0 : skillBonuses[bonus]));
        }
    }

    private clearBonuses(): void {
        this._bonuses = {
            offensive: {
                speed: 0, stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0
            },
            defensive: {
                stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0
            },
            skill: {
                strength: 0, prayer: 0
            }
        };
    }

    private loadSaveData(): void {
        const playerSave: PlayerSave = loadPlayerSave(this.username);
        const firstTimePlayer: boolean = playerSave === null;
        this.firstTimePlayer = firstTimePlayer;

        if(!firstTimePlayer) {
            if(playerSave.savedMetadata) {
                this.savedMetadata = playerSave.savedMetadata;
            }

            // Existing player logging in
            this.position = new Position(playerSave.position.x, playerSave.position.y, playerSave.position.level);
            if(playerSave.inventory && playerSave.inventory.length !== 0) {
                this.inventory.setAll(playerSave.inventory);
            }
            if(playerSave.bank && playerSave.bank.length !== 0) {
                this.bank.setAll(playerSave.bank);
            }
            if(playerSave.equipment && playerSave.equipment.length !== 0) {
                this.equipment.setAll(playerSave.equipment);
            }
            if(playerSave.skills && playerSave.skills.length !== 0) {
                this.skills.values = playerSave.skills;
            }
            this._appearance = playerSave.appearance;
            this._settings = playerSave.settings;
            this._rights = playerSave.rights || Rights.USER;

            const lastLogin = playerSave.lastLogin?.date;
            if(!lastLogin) {
                this._loginDate = new Date();
            } else {
                this._loginDate = new Date(lastLogin);
            }

            if(playerSave.quests) {
                this.quests = playerSave.quests;
            }
            if(playerSave.achievements) {
                this.achievements = playerSave.achievements;
            }
            if(playerSave.friendsList) {
                this.friendsList = playerSave.friendsList;
            }
            if(playerSave.ignoreList) {
                this.ignoreList = playerSave.ignoreList;
            }

            this._lastAddress = playerSave.lastLogin?.address || (this._socket?.address() as AddressInfo)?.address || '127.0.0.1';
        } else {
            // Brand new player logging in
            this.position = new Position(3231, 3239);
            this._appearance = defaultAppearance();
            this._rights = Rights.USER;
            this.savedMetadata = {
                tutorialProgress: 0,
                tutorialComplete: false
            };
        }

        if(!this._settings) {
            this._settings = defaultSettings();
        }
    }

    public set position(position: Position) {
        super.position = position;

        if(this.quadtreeKey !== null) {
            world.playerTree.remove(this.quadtreeKey);
        }

        this.quadtreeKey = { x: position.x, y: position.y, actor: this };
        world.playerTree.push(this.quadtreeKey);
    }

    public get position(): Position {
        return super.position;
    }

    public get socket(): Socket {
        return this._socket;
    }

    public get inCipher(): Isaac {
        return this._inCipher;
    }

    public get outCipher(): Isaac {
        return this._outCipher;
    }

    public get outgoingPackets(): OutboundPackets {
        return this._outgoingPackets;
    }

    public get loginDate(): Date {
        return this._loginDate;
    }

    public get lastAddress(): string {
        return this._lastAddress;
    }

    public get rights(): Rights {
        return this._rights;
    }

    public get appearance(): Appearance {
        return this._appearance;
    }

    public set appearance(value: Appearance) {
        this._appearance = value;
    }

    public get activeWidget(): PlayerWidget {
        return this._activeWidget;
    }

    public set activeWidget(value: PlayerWidget) {
        if(value !== null) {
            value.closed = new Subject<void>();

            if(value.beforeOpened !== undefined) {
                value.beforeOpened();
            }

            if(value.type === 'SCREEN') {
                this.outgoingPackets.showScreenWidget(value.widgetId);
            } else if(value.type === 'CHAT') {
                this.outgoingPackets.showChatboxWidget(value.widgetId);
            } else if(value.type === 'FULLSCREEN') {
                this.outgoingPackets.showFullscreenWidget(value.widgetId, value.secondaryWidgetId);
            } else if(value.type === 'SCREEN_AND_TAB') {
                this.outgoingPackets.showScreenAndTabWidgets(value.widgetId, value.secondaryWidgetId);
            }

            if(value.afterOpened !== undefined) {
                value.afterOpened();
            }
        } else {
            this.outgoingPackets.closeActiveWidgets();
        }

        this.actionsCancelled.next('keep-widgets-open');
        this._activeWidget = value;
    }

    public get equipment(): ItemContainer {
        return this._equipment;
    }


    public get carryWeight(): number {
        return this._carryWeight;
    }

    public get settings(): PlayerSettings {
        return this._settings;
    }

    public get walkingTo(): Position {
        return this._walkingTo;
    }

    public set walkingTo(value: Position) {
        this._walkingTo = value;
    }

    public get nearbyChunks(): Chunk[] {
        return this._nearbyChunks;
    }

    public get bonuses(): { offensive: OffensiveBonuses, defensive: DefensiveBonuses, skill: SkillBonuses } {
        return this._bonuses;
    }
}
