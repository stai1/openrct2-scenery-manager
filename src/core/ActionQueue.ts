/*****************************************************************************
 * Copyright (c) 2020-2026 Sadret
 *
 * The OpenRCT2 plugin "Scenery Manager" is licensed
 * under the GNU General Public License version 3.
 *****************************************************************************/

import * as Objects from "../utils/Objects";
import * as Context from "./Context";

import Configuration from "../config/Configuration";

/*
 * Queue for actions that are subject to the rate limit. Settings are re-read
 * every tick and whenever they change, so changes also affect a pending wait.
 *
 * The interval and timeout are counted in game ticks: a client cannot run
 * ahead of the server's tick, so waiting n ticks on the client guarantees that
 * the server has advanced at least n ticks as well, even if it froze in the
 * meantime. For the same reason, a server freeze doesn't use up the timeout.
 */

interface QueuedAction {
    readonly data: ActionData<any, any>;
    readonly callback?: (result: GameActionResult) => void;
}

const elementTypes: { [action: string]: [string, "place" | "remove"] } = {
    bannerplace: ["banner", "place"],
    bannerremove: ["banner", "remove"],
    rideentranceexitplace: ["entrance", "place"],
    rideentranceexitremove: ["entrance", "remove"],
    footpathplace: ["footpath", "place"],
    footpathremove: ["footpath", "remove"],
    footpathadditionplace: ["footpath_addition", "place"],
    footpathadditionremove: ["footpath_addition", "remove"],
    largesceneryplace: ["large_scenery", "place"],
    largesceneryremove: ["large_scenery", "remove"],
    smallsceneryplace: ["small_scenery", "place"],
    smallsceneryremove: ["small_scenery", "remove"],
    trackplace: ["track", "place"],
    trackremove: ["track", "remove"],
    wallplace: ["wall", "place"],
    wallremove: ["wall", "remove"],
};

const queue: QueuedAction[] = [];
// true while the queue is being processed or waits for a response / interval
let busy = false;
// action whose response is awaited, and the tick it was sent at
let awaiting: { entry: QueuedAction, tick: number } | undefined = undefined;
// action whose response was received, and the tick it was received at
let interval: { entry: QueuedAction, tick: number } | undefined = undefined;
let subscribed = false;

const rateLimit = Configuration.rateLimit;
const onSettingChanged = () => {
    runUnlimited();
    update();
};
rateLimit.enabled.bind(onSettingChanged, false);
rateLimit.intervalTicks.bind(onSettingChanged, false);
rateLimit.timeoutTicks.bind(onSettingChanged, false);
Objects.values(rateLimit.actions).forEach(actions => {
    actions.place.bind(onSettingChanged, false);
    actions.remove.bind(onSettingChanged, false);
});

export function enqueue(data: ActionData<any, any>, callback?: (result: GameActionResult) => void): void {
    if (!subscribed) {
        context.subscribe("interval.tick", update);
        subscribed = true;
    }
    // actions that are not rate limited skip the queue
    if (!isRateLimited(data))
        return Context.queryExecuteActionCallback(data, callback);
    queue.push({ data, callback });
    if (!busy)
        processQueue();
}

function isRateLimited(data: ActionData<any, any>): boolean {
    if (!rateLimit.enabled.getValue())
        return false;
    const elementType = elementTypes[data.type];
    if (elementType === undefined)
        return false;
    return rateLimit.actions[elementType[0]][elementType[1]].getValue();
}

/*
 * Runs all queued actions that are no longer rate limited (e.g. because their type was unchecked).
 */
function runUnlimited(): void {
    // running an action may enqueue new ones, so the length is re-read in every iteration
    for (let idx = 0; idx < queue.length;) {
        const entry = queue[idx];
        if (isRateLimited(entry.data))
            idx++;
        else {
            queue.splice(idx, 1);
            Context.queryExecuteActionCallback(entry.data, entry.callback);
        }
    }
}

function processQueue(): void {
    busy = true;
    awaiting = undefined;
    interval = undefined;
    for (runUnlimited(); queue.length > 0; runUnlimited())
        if (dispatch(queue.shift() as QueuedAction))
            // processQueue is called again by update once the response and interval have passed
            return;
    busy = false;
}

/*
 * Called every tick and whenever a rate limit setting changes.
 */
function update(): void {
    if (awaiting !== undefined) {
        // stop waiting for a response that may never come (e.g. if the server rejected the action)
        if (!isRateLimited(awaiting.entry.data))
            processQueue();
        else if (date.ticksElapsed - awaiting.tick >= rateLimit.timeoutTicks.getValue()) {
            if (rateLimit.onTimeout.getValue() === "retry")
                queue.unshift(awaiting.entry);
            // the server may have counted the action even if it rejected it, so wait the interval before sending the next one
            interval = { entry: awaiting.entry, tick: date.ticksElapsed };
            awaiting = undefined;
            update();
        }
    } else if (interval !== undefined) {
        if (!isRateLimited(interval.entry.data) || date.ticksElapsed - interval.tick >= rateLimit.intervalTicks.getValue())
            processQueue();
    }
}

/*
 * Returns true if the action was sent and a response is awaited, false if it
 * was rejected by the local query (nothing is sent, so there is nothing to wait for).
 */
function dispatch(entry: QueuedAction): boolean {
    let returned = false;
    let rejected = false;
    context.queryAction(entry.data.type, entry.data.args, queryResult => {
        if (!queryResult.error)
            return execute(entry);
        rejected = true;
        entry.callback && entry.callback(queryResult);
        // the query callback is synchronous in current OpenRCT2, but don't stall if it isn't
        if (returned)
            processQueue();
    });
    returned = true;
    return !rejected;
}

function execute(entry: QueuedAction): void {
    awaiting = { entry, tick: date.ticksElapsed };
    // In a network game, the callback fires once the server has relayed the action back,
    // or immediately if the client rejects it. It never fires if the server rejects it.
    context.executeAction(entry.data.type, entry.data.args, result => {
        // ignore responses that are no longer awaited
        // (a late response to an earlier attempt of a retried action is accepted as the response to the retry)
        if (awaiting === undefined || awaiting.entry !== entry)
            return;
        awaiting = undefined;
        entry.callback && entry.callback(result);
        interval = { entry, tick: date.ticksElapsed };
        // ticks don't advance while the game is paused, so an interval of 0 must not wait for one
        context.setTimeout(update, 0);
    });
}
