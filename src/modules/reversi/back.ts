/**
 * -AI-
 * Botのバックエンド(思考を担当)
 *
 * 対話と思考を同じプロセスで行うと、思考時間が長引いたときにストリームから
 * 切断されてしまうので、別々のプロセスで行うようにします
 */

import got from 'got';
import * as Reversi from './engine.js';
import config from '@/config.js';
import serifs from '@/serifs.js';
import type { User } from '@/misskey/user.js';
import fetch from 'node-fetch';

function getUserName(user) {
	return user.name || user.username;
}

const titles = [
	'さん', 'サン', 'ｻﾝ', '㌠',
	'ちゃん', 'チャン', 'ﾁｬﾝ',
	'君', 'くん', 'クン', 'ｸﾝ',
	'先生', 'せんせい', 'センセイ', 'ｾﾝｾｲ'
];

class Session {
	private account: User;
	private game: any;
	private form: any;
	private engine: Reversi.Game;
	private botColor: Reversi.Color;

	private appliedOps: string[] = [];

	/**
	 * 最大のターン数
	 */
	private maxTurn;

	/**
	 * 現在のターン数
	 */
	private currentTurn = 0;

	/**
	 * 対局が開始したことを知らせた投稿
	 */
	private startedNote: any = null;

	private get user(): User {
		return this.game.user1Id == this.account.id ? this.game.user2 : this.game.user1;
	}

	private get userName(): string {
		const name = getUserName(this.user);
		return `?[${name}](${config.host}/@${this.user.username})${titles.some(x => name.endsWith(x)) ? '' : 'さん'}`;
	}

	private get allowPost(): boolean {
		return this.form.find(i => i.id == 'publish').value;
	}

	private get url(): string {
		return `${config.host}/reversi/g/${this.game.id}`;
	}

	constructor() {
		process.on('message', this.onMessage);
	}

	private onMessage = async (msg: any) => {
		switch (msg.type) {
			case '_init_': this.onInit(msg.body); break;
			case 'started': this.onStarted(msg.body); break;
			case 'ended': this.onEnded(msg.body); break;
			case 'log': this.onLog(msg.body); break;
		}
	}

	// 親プロセスからデータをもらう
	private onInit = (msg: any) => {
		this.game = msg.game;
		this.form = msg.form;
		this.account = msg.account;
	}

	/**
	 * 対局が始まったとき
	 */
	private onStarted = (msg: any) =>  {
		this.game = msg.game;
		if (this.game.canPutEverywhere) { // 対応してない
			process.send!({
				type: 'ended'
			});
			process.exit();
		}

		// リバーシエンジン初期化
		this.engine = new Reversi.Game(this.game.map, {
			isLlotheo: this.game.isLlotheo,
			canPutEverywhere: this.game.canPutEverywhere,
			loopedBoard: this.game.loopedBoard
		});

		this.maxTurn = this.engine.map.filter(p => p === 'empty').length - this.engine.board.filter(x => x != null).length;

		this.botColor = this.game.user1Id == this.account.id && this.game.black == 1 || this.game.user2Id == this.account.id && this.game.black == 2;

		if (this.botColor) {
			this.think();
		}
	}

	/**
	 * 対局が終わったとき
	 */
	private onEnded = async (msg: any) =>  {
		// ストリームから切断
		process.send!({
			type: 'ended'
		});

		let text: string;

		if (msg.game.surrendered) {
			if (this.isSettai) {
				text = serifs.reversi.settaiButYouSurrendered(this.userName);
			} else {
				text = serifs.reversi.youSurrendered(this.userName);
			}
		} else if (msg.winnerId) {
			if (msg.winnerId == this.account.id) {
				if (this.isSettai) {
					text = serifs.reversi.iWonButSettai(this.userName);
				} else {
					text = serifs.reversi.iWon(this.userName);
				}
			} else {
				if (this.isSettai) {
					text = serifs.reversi.iLoseButSettai(this.userName);
				} else {
					text = serifs.reversi.iLose(this.userName);
				}
			}
		} else {
			if (this.isSettai) {
				text = serifs.reversi.drawnSettai(this.userName);
			} else {
				text = serifs.reversi.drawn(this.userName);
			}
		}

		await this.post(text, this.startedNote);

		process.exit();
	}

	/**
	 * 打たれたとき
	 */
	private onLog = (log: any) => {
		if (log.id == null || !this.appliedOps.includes(log.id)) {
			switch (log.operation) {
				case 'put': {
					this.engine.putStone(log.pos);
					this.currentTurn++;

					if (this.engine.turn === this.botColor) {
						this.think();
					}
					break;
				}

				default:
					break;
			}
		}
	}

	// Convert the board state to a 64-digit string
	private boardStateToString(): string {
		return this.engine.board.map(cell => {
				if (cell === null) return '0';
				return cell === Reversi.BLACK ? '1' : '2';
		}).join('');
	}

	private executeCurlCommand = async (curlCommand: string): Promise<number> => {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execPromise = promisify(exec);

    try {
        const { stdout, stderr } = await execPromise(curlCommand);
        if (stderr) {
            throw new Error(`Error executing curl command: ${stderr}`);
        }
        const response = parseInt(stdout.trim(), 10);
        if (isNaN(response) || response < 0 || response > 63) {
            throw new Error(`Invalid response from server: ${stdout}`);
        }
        return response;
    } catch (error) {
        console.error(`Error in executeCurlCommand: ${error.message}`);
        throw error; // or handle error as appropriate
    }
};

	private async think() {
		const boardState = this.boardStateToString();
		const turnValue = this.game.turn === Reversi.BLACK ? 0 : 1;
		try {
				const response = await fetch('http://127.0.0.1:5000/put', {
						method: 'PUT',
						headers: {
								'Accept': '*/*',
								'Connection': 'keep-alive'
						},
						body: new URLSearchParams({
								'board': boardState,
								'turn': turnValue.toString()
						})
				});

				if (!response.ok) {
						throw new Error(`HTTP error! status: ${response.status}`);
				}

				const nextMove = await response.text();
				console.log('Curl response:', nextMove);
				this.engine.putStone(nextMove);
				this.currentTurn++;
		} catch (error) {
				console.error('Error sending request:', error);
		}
}

	/**
	 * Misskeyに投稿します
	 * @param text 投稿内容
	 */
	private post = async (text: string, renote?: any) => {
		if (this.allowPost) {
			const body = {
				i: config.i,
				text: text,
				visibility: 'home'
			} as any;

			if (renote) {
				body.renoteId = renote.id;
			}

			try {
				const res = await got.post(`${config.host}/api/notes/create`, {
					json: body
				}).json();

				return res.createdNote;
			} catch (e) {
				console.error(e);
				return null;
			}
		} else {
			return null;
		}
	}
}

new Session();
