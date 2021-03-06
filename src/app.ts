'use strict';

import * as Debug from 'debug';
import { fork } from 'child_process';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as helmet from 'helmet';
import * as db from './utils/db';
import * as github from './utils/github';
import config from './utils/config';
import writeConfig from './utils/writeConfig';
import router from './utils/router';

const debug = Debug('app');
const app = express();

export const update = async (): Promise<void> => {
    /* Create and write to cache.db */
    debug('Spawning update process...');
    const updateProcess = fork(path.join(__dirname, 'scripts/update.ts'));
    updateProcess.on('message', async data => {
        await db.run('BEGIN TRANSACTION');
        await Promise.all(
            data.map(async scam => {
                await db.run('UPDATE entries SET ip=?,status=?,statusCode=?,updated=? WHERE id=?', [
                    scam.ip,
                    scam.status,
                    scam.statusCode,
                    scam.updated,
                    scam.id
                ]);
                const nameservers: any = await db.all('SELECT * FROM nameservers WHERE entry=?', [
                    scam.id
                ]);
                await Promise.all(
                    nameservers.map(async nameserver => {
                        if (!(nameserver.nameserver in scam.nameservers)) {
                            await db.run('DELETE FROM nameservers WHERE nameserver=? AND entry=?', [
                                nameserver.nameserver,
                                nameserver.entry
                            ]);
                        }
                    })
                );
                await Promise.all(
                    scam.nameservers.map(async nameserver => {
                        await db.run('INSERT OR IGNORE INTO nameservers VALUES (?,?)', [
                            nameserver,
                            scam.id
                        ]);
                    })
                );
            })
        );
        await db.run('COMMIT');
    });

    /* After db is initially written, write the cache.db every cacheRenewCheck-defined period */
    updateProcess.on('exit', () => {
        debug(
            'UpdateProcess completed - Next run is in ' +
                config.interval.cacheRenewCheck / 1000 +
                ' seconds.'
        );
        setTimeout(() => {
            this.update();
        }, config.interval.cacheRenewCheck);
    });
};

export const createPR = async (): Promise<void> => {
    try {
        db.createPR();
    } catch (err) {
        debug('Error adding new PR:' + err);
    }

    setInterval(() => {
        try {
            db.createPR();
        } catch (err) {
            debug('Error adding new PR:' + err);
        }
    }, config.autoPR.interval);
};

export const serve = async (electronApp?: any): Promise<void> => {
    /* Download datafiles if they aren't found yet */
    if (!fs.existsSync('data')) {
        await github.pullRaw();
    }

    /* Initiate database */
    await db.init();

    /* Allow both JSON and URL encoded bodies */
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    /* Set security headers */
    app.use(helmet());
    app.use(helmet.referrerPolicy());

    /* Compress pages */
    app.use(require('compression')());

    /* Serve all other routes (see src/utils/router.js) */
    app.use(router);

    /* Serve all other pages as 404 */
    app.get('*', (req, res) => res.status(404).render('404'));

    /* Listen to port (defined in config */
    app.listen(config.port, () => debug('Content served on http://localhost:%s', config.port));

    /* Update scams after 100ms timeout (to process async) */
    setTimeout(() => this.update(), 100);

    setTimeout(() => this.createPR(), 100);

    /* If auto pulling from Github is enabled; schedule timer */
    if (config.autoPull.enabled) {
        setInterval(github.pullData, config.autoPull.interval);
    }

    if (config.interval.priceLookup > 0) {
        setInterval(db.priceUpdate, config.interval.priceLookup);
    }
};

if (!module.parent) {
    this.serve().catch(console.error);
}
