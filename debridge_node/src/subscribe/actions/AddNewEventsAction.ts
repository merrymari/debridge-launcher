import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectRepository } from '@nestjs/typeorm';
import { SupportedChainEntity } from '../../entities/SupportedChainEntity';
import { EntityManager, Repository } from 'typeorm';
import { SubmissionEntity } from '../../entities/SubmissionEntity';
import { SubmisionStatusEnum } from '../../enums/SubmisionStatusEnum';
import { abi as deBridgeGateAbi } from '../../assets/DeBridgeGate.json';
import { SubmisionAssetsStatusEnum } from '../../enums/SubmisionAssetsStatusEnum';
import { Web3Service } from '../../services/Web3Service';
import { UploadStatusEnum } from '../../enums/UploadStatusEnum';
import { ChainConfigService } from '../../services/ChainConfigService';

@Injectable()
export class AddNewEventsAction implements OnModuleInit {
  logger: Logger;
  private readonly locker = new Map();
  private readonly maxNonceChains = new Map();

  constructor(
    @InjectRepository(SupportedChainEntity)
    private readonly supportedChainRepository: Repository<SupportedChainEntity>,
    @InjectRepository(SubmissionEntity)
    private readonly submissionsRepository: Repository<SubmissionEntity>,
    private readonly chainConfigService: ChainConfigService,
    private readonly web3Service: Web3Service,
    @InjectConnection()
    private readonly entityManager: EntityManager,
  ) {
    this.logger = new Logger(AddNewEventsAction.name);
  }

  async action(chainId: number) {
    if (this.locker.get(chainId)) {
      this.logger.warn(`Is working now. chainId: ${chainId}`);
      return;
    }
    try {
      this.locker.set(chainId, true);
      this.logger.log(`Is locked chainId: ${chainId}`);
      await this.process(chainId);
    } catch (e) {
      this.logger.error(e);
    } finally {
      this.locker.set(chainId, false);
      this.logger.log(`Is unlocked chainId: ${chainId}`);
    }
  }

  /**
   * Process new transfers
   * @param {EventData[]} events
   * @param {number} chainIdFrom
   * @private
   */
  async processNewTransfers(events: any[], chainIdFrom: number): Promise<number | 'incorrect_nonce'> {
    let lastSuccessBlock;
    if (!events) return;
    for (const sendEvent of events) {
      this.logger.log(`processNewTransfers chainIdFrom ${chainIdFrom}; submissionId: ${sendEvent.returnValues.submissionId}`);
      //this.logger.debug(JSON.stringify(sentEvents));
      const submissionId = sendEvent.returnValues.submissionId;
      const nonce = parseInt(sendEvent.returnValues.nonce);
      const submission = await this.submissionsRepository.findOne({
        where: {
          submissionId,
        },
      });
      if (submission) {
        this.logger.verbose(`Submission already found in db submissionId: ${submissionId}`);
        continue;
      }

      if (nonce !== this.maxNonceChains.get(chainIdFrom) + 1) {
        const message = `Incorrect nonce ${nonce} in scanning from ${submission.chainFrom}`;
        this.logger.error(message);
        return 'incorrect_nonce';
      } else {
        this.maxNonceChains.set(submission.chainFrom, nonce);
      }

      try {
        await this.submissionsRepository.save({
          submissionId: submissionId,
          txHash: sendEvent.transactionHash,
          chainFrom: chainIdFrom,
          chainTo: sendEvent.returnValues.chainIdTo,
          debridgeId: sendEvent.returnValues.debridgeId,
          receiverAddr: sendEvent.returnValues.receiver,
          amount: sendEvent.returnValues.amount,
          status: SubmisionStatusEnum.NEW,
          ipfsStatus: UploadStatusEnum.NEW,
          apiStatus: UploadStatusEnum.NEW,
          assetsStatus: SubmisionAssetsStatusEnum.NEW,
          rawEvent: JSON.stringify(sendEvent),
          blockNumber: sendEvent.blockNumber,
          nonce,
        } as SubmissionEntity);
        lastSuccessBlock = sendEvent.blockNumber;
      } catch (e) {
        this.logger.error(`Error in saving ${submissionId}`);
        throw e;
      }
    }
    return lastSuccessBlock;
  }

  async getEvents(registerInstance, fromBlock: number, toBlock) {
    if (fromBlock >= toBlock) return;

    /* get events */
    const sentEvents = await registerInstance.getPastEvents(
      'Sent',
      { fromBlock, toBlock }, //,
      //async (error, events) => {
      //    if (error) {
      //        this.log.error(error);
      //    }
      //    await this.processNewTransfers(events, supportedChain.chainId);
      //}
    );

    // this.logger.debug('getEvents: ' + JSON.stringify(sentEvents));

    return sentEvents;
  }

  /**
   * Process events by period
   * @param {string} chainId
   * @param {number} from
   * @param {number} to
   */
  async process(chainId: number, from: number = undefined, to: number = undefined) {
    this.logger.verbose(`checkNewEvents ${chainId}`);
    const supportedChain = await this.supportedChainRepository.findOne({
      where: {
        chainId,
      },
    });
    const chainDetail = this.chainConfigService.get(chainId);

    const web3 = await this.web3Service.web3HttpProvider(chainDetail.providers);

    const registerInstance = new web3.eth.Contract(deBridgeGateAbi as any, chainDetail.debridgeAddr);

    const toBlock = to || (await web3.eth.getBlockNumber()) - chainDetail.blockConfirmation;
    let fromBlock = from || (supportedChain.latestBlock > 0 ? supportedChain.latestBlock : toBlock - 1);

    this.logger.debug(`Getting events from ${fromBlock} to ${toBlock} ${supportedChain.network}`);

    for (fromBlock; fromBlock < toBlock; fromBlock += chainDetail.maxBlockRange) {
      const lastBlockOfPage = Math.min(fromBlock + chainDetail.maxBlockRange, toBlock);
      this.logger.log(`checkNewEvents ${supportedChain.network} ${fromBlock}-${lastBlockOfPage}`);

      const sentEvents = await this.getEvents(registerInstance, fromBlock, lastBlockOfPage);
      const processSuccess = await this.processNewTransfers(sentEvents, supportedChain.chainId);

      if (processSuccess === 'incorrect_nonce') {
        // @ts-ignore
        chainDetail.providers.setProviderStatus(web3.currentProvider.provider, false);
        break;
      }

      /* update lattest viewed block */
      if (processSuccess) {
        if (supportedChain.latestBlock != lastBlockOfPage) {
          this.logger.log(`updateSupportedChainBlock chainId: ${chainId}; key: latestBlock; value: ${lastBlockOfPage}`);
          await this.supportedChainRepository.update(chainId, {
            latestBlock: processSuccess,
          });
        }
      } else {
        this.logger.error(`checkNewEvents. Last block not updated. Found error in processNewTransfers ${chainId}`);
        break;
      }
    }
  }

  async onModuleInit() {
    const chains = await this.entityManager.query(`
 SELECT "chainFrom", MAX(nonce) FROM public.submissions GROUP BY "chainFrom"
        `);
    for (const { chainFrom, max } of chains) {
      this.maxNonceChains.set(chainFrom, max);
      this.logger.verbose(`Max nonce in chain ${chainFrom} is ${max}`);
    }
  }
}
