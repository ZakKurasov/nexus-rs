import { RunePlugin } from '@server/plugins/plugin';
import { commandAction } from '@server/world/action/player-command-action';
import { world } from '@server/game-server';
import { LocationObject } from '@runejs/cache-parser';
import { Position } from '@server/world/position';
import { objectIds } from '@server/world/config/object-ids';
import { safeDump } from 'js-yaml';
import { writeFileSync } from 'fs';
import { ActionType } from '@server/world/action';
import { logger } from '@runejs/core';

const spawnSceneryAction: commandAction = (details) => {
    const { player, args } = details;

    const locationObjectSearch: string = (args.locationObjectSearch as string).trim();
    let locationObjectId: number;

    if(locationObjectSearch.match(/^[0-9]+$/)) {
        locationObjectId = parseInt(locationObjectSearch, 10);
    } else {
        // @TODO nested object ids
        locationObjectId = objectIds[locationObjectSearch];
    }

    if(isNaN(locationObjectId)) {
        throw new Error(`Location object name not found.`);
    }

    const objectType = args.objectType as number;
    const objectOrientation = args.objectOrientation as number;

    const position = player.position.copy();

    const locationObject: LocationObject = {
        objectId: locationObjectId,
        x: position.x,
        y: position.y,
        level: position.level,
        type: objectType,
        orientation: objectOrientation
    };

    player.metadata.lastSpawnedScenery = locationObject;

    if(!player.metadata.spawnedScenery) {
        player.metadata.spawnedScenery = [];
    }

    player.metadata.spawnedScenery.push(locationObject);

    world.addLocationObject(locationObject, position);
};

const undoSceneryAction: commandAction = (details) => {
    const { player } = details;

    const o: LocationObject = player.metadata.lastSpawnedScenery;

    if(!o) {
        return;
    }

    world.removeLocationObject(o, new Position(o.x, o.y, o.level));
    delete player.metadata.lastSpawnedScenery;

    if(player.metadata.spawnedScenery) {
        player.metadata.spawnedScenery.pop();
    }
};

const dumpSceneryAction: commandAction = (details) => {
    const { player } = details;

    const path = `data/dump/scene-${ new Date().getTime() }.yml`;
    writeFileSync(path, safeDump(player.metadata.spawnedScenery));
    logger.info(path);
    player.metadata.spawnedScenery = [];
};

export default [{
    type: 'player_command',
    commands: [ 'scene', 'sc' ],
    args: [
        {
            name: 'locationObjectSearch',
            type: 'string'
        },
        {
            name: 'objectOrientation',
            type: 'number',
            defaultValue: 0
        },
        {
            name: 'objectType',
            type: 'number',
            defaultValue: 10
        }
    ],
    action: spawnSceneryAction
}, {
    type: 'player_command',
    commands: [ 'undoscene', 'undosc' ],
    action: undoSceneryAction
}, {
    type: 'player_command',
    commands: [ 'dumpscene', 'dumpsc' ],
    action: dumpSceneryAction
}];
