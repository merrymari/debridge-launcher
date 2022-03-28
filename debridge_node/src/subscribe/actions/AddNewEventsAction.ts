import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BigNumber } from 'bignumber.js';
import { Repository } from 'typeorm';

import { abi as deBridgeGateAbi } from '../../assets/DeBridgeGate.json';
import { MonitoringSentEventEntity } from '../../entities/MonitoringSentEventEntity';
import { SubmissionEntity } from '../../entities/SubmissionEntity';
import { SupportedChainEntity } from '../../entities/SupportedChainEntity';
import { SubmisionAssetsStatusEnum } from '../../enums/SubmisionAssetsStatusEnum';
import { SubmisionBalanceStatusEnum } from '../../enums/SubmisionBalanceStatusEnum';
import { SubmisionStatusEnum } from '../../enums/SubmisionStatusEnum';
import { UploadStatusEnum } from '../../enums/UploadStatusEnum';
import { ChainConfigService, ChainProvider } from '../../services/ChainConfigService';
import { ChainScanningService } from '../../services/ChainScanningService';
import { DebrdigeApiService } from '../../services/DebrdigeApiService';
import { NonceControllingService } from '../../services/NonceControllingService';
import { Web3Custom, Web3Service } from '../../services/Web3Service';

export enum ProcessNewTransferResultStatusEnum {
  SUCCESS,
  ERROR,
}

export enum NonceValidationEnum {
  SUCCESS,
  MISSED_NONCE,
  DUPLICATED_NONCE,
}

interface ProcessNewTransferResult {
  blockToOverwrite?: number;
  status: ProcessNewTransferResultStatusEnum;
  nonceValidationStatus?: NonceValidationEnum;
  submissionId?: string;
  nonce?: number;
}

@Injectable()
export class AddNewEventsAction {
  private readonly logger = new Logger(AddNewEventsAction.name);
  private readonly locker = new Map();

  constructor(
    @Inject(forwardRef(() => ChainScanningService))
    private readonly chainScanningService: ChainScanningService,
    @InjectRepository(SupportedChainEntity)
    private readonly supportedChainRepository: Repository<SupportedChainEntity>,
    @InjectRepository(SubmissionEntity)
    private readonly submissionsRepository: Repository<SubmissionEntity>,
    @InjectRepository(MonitoringSentEventEntity)
    private readonly monitoringSentEventRepository: Repository<MonitoringSentEventEntity>,
    private readonly chainConfigService: ChainConfigService,
    private readonly web3Service: Web3Service,
    private readonly nonceControllingService: NonceControllingService,
    private readonly debridgeApiService: DebrdigeApiService,
  ) {}

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
      this.logger.error(`Error while scanning chainId: ${chainId}; error: ${e.message} ${JSON.stringify(e)}`);
    } finally {
      this.locker.set(chainId, false);
      this.logger.log(`Is unlocked chainId: ${chainId}`);
    }
  }

  /**
   * Process events by period
   * @param {string} chainId
   * @param {number} from
   * @param {number} to
   */
  async process(chainId: number, from: number = undefined, to: number = undefined) {
    if (chainId != 1) {
      return;
    }
    const logger = new Logger(`${AddNewEventsAction.name} chainId ${chainId}`);
    logger.verbose(`process checkNewEvents - chainId: ${chainId}; from: ${from}; to: ${to}`);
    const supportedChain = await this.supportedChainRepository.findOne({
      where: {
        chainId,
      },
    });

    const chainDetail = this.chainConfigService.get(chainId);

    const web3 = await this.web3Service.web3HttpProvider(chainDetail.providers);

    const contract = new web3.eth.Contract(deBridgeGateAbi as any, chainDetail.debridgeAddr);

    // @ts-ignore
    web3.eth.setProvider = contract.setProvider;
    const toBlock = to || (await web3.eth.getBlockNumber()) - chainDetail.blockConfirmation;
    let fromBlock = from || (supportedChain.latestBlock > 0 ? supportedChain.latestBlock : toBlock - 1);

    logger.debug(`Getting events from ${fromBlock} to ${toBlock} ${supportedChain.network}`);

    for (fromBlock; fromBlock < toBlock; fromBlock += chainDetail.maxBlockRange) {
      const lastBlockOfPage = Math.min(fromBlock + chainDetail.maxBlockRange, toBlock);
      logger.log(`supportedChain.network: ${supportedChain.network} ${fromBlock}-${lastBlockOfPage}`);
      if (supportedChain.latestBlock === lastBlockOfPage) {
        logger.warn(`latestBlock in db ${supportedChain.latestBlock} == lastBlockOfPage ${lastBlockOfPage}`);
        continue;
      }
      const monitoringSentEvents = await this.getEvents(contract, 'MonitoringSendEvent', fromBlock, lastBlockOfPage);
      const sentEvents = await this.getEvents(contract, 'Sent', fromBlock, lastBlockOfPage);
      logger.log(`sentEvents: ${JSON.stringify(sentEvents)}`);
      if (!sentEvents || sentEvents.length === 0) {
        logger.verbose(`Not found any events for ${chainId} ${fromBlock} - ${lastBlockOfPage}`);
        await this.supportedChainRepository.update(chainId, {
          latestBlock: lastBlockOfPage,
        });
        continue;
      }

      const result = await this.processNewTransfers(
        logger,
        web3,
        sentEvents,
        monitoringSentEvents,
        supportedChain.chainId,
        chainDetail.firstMonitoringBlock,
      );
      const updatedBlock = result.status === ProcessNewTransferResultStatusEnum.SUCCESS ? lastBlockOfPage : result.blockToOverwrite;

      // updatedBlock can be undefined if incorrect nonce occures in the first event
      if (updatedBlock) {
        logger.log(`updateSupportedChainBlock; key: latestBlock; value: ${updatedBlock};`);
        const block = await web3.eth.getBlock(updatedBlock);
        const blockTimestamp = parseInt(block.timestamp.toString());
        await this.supportedChainRepository.update(chainId, {
          latestBlock: updatedBlock,
          validationTimestamp: blockTimestamp,
        });
      }
      if (result.status != ProcessNewTransferResultStatusEnum.SUCCESS) {
        await this.processValidationNonceError(web3, this.debridgeApiService, this.chainScanningService, result, chainId, chainDetail.providers);
        break;
      }
    }
  }

  /**
   * Process new transfers
   * @param logger
   * @param sentEvents
   * @param monitoringSentEvents
   * @param {number} chainIdFrom
   * @private
   */
  async processNewTransfers(
    logger: Logger,
    web3: Web3Custom,
    sentEvents: any[],
    monitoringSentEvents: any[],
    chainIdFrom: number,
    firstMonitoringBlock: number,
  ): Promise<ProcessNewTransferResult> {
    let blockToOverwrite;
    const monitoringSentEventsMap = new Map<string, any>();
    for (const event of monitoringSentEvents) {
      monitoringSentEventsMap.set(event.returnValues.submissionId, event);
    }

    for (const sendEvent of sentEvents) {
      const submissionId = sendEvent.returnValues.submissionId;
      logger.log(`submissionId: ${submissionId}`);
      const nonce = parseInt(sendEvent.returnValues.nonce);

      // check nonce collission
      // check if submission from rpc with the same submissionId have the same nonce
      const submission = await this.submissionsRepository.findOne({
        where: {
          submissionId,
        },
      });
      const monitoring = await this.monitoringSentEventRepository.findOne({
        where: {
          submissionId,
          nonce: submission.nonce,
        },
      });
      if (submission && monitoring) {
        logger.verbose(`Submission and monitoring event already found in db; submissionId: ${submissionId}`);
        blockToOverwrite = submission.blockNumber;
        this.nonceControllingService.set(chainIdFrom, submission.nonce);
        continue;
      }

      if (submission && submission.blockNumber < firstMonitoringBlock) {
        logger.verbose(`Submission already found in db; submissionId: ${submissionId}`);
        blockToOverwrite = submission.blockNumber;
        this.nonceControllingService.set(chainIdFrom, submission.nonce);
        continue;
      }

      // validate nonce
      const maxNonceFromDb = this.nonceControllingService.get(chainIdFrom);
      const submissionWithMaxNonceDb = await this.submissionsRepository.findOne({
        where: {
          chainFrom: chainIdFrom,
          nonce: maxNonceFromDb,
        },
      });
      const nonceExists = await this.isSubmissionExists(chainIdFrom, nonce);
      const nonceValidationStatus = this.getNonceStatus(maxNonceFromDb, nonce, nonceExists);

      logger.verbose(`Nonce validation status ${nonceValidationStatus}; maxNonceFromDb: ${maxNonceFromDb}; nonce: ${nonce};`);

      const blockNumber = blockToOverwrite !== undefined ? blockToOverwrite : submissionWithMaxNonceDb.blockNumber;
      const block = await web3.eth.getBlock(blockNumber);
      const blockTimestamp = parseInt(block.timestamp.toString());
      const executionFee = this.getExecutionFee(sendEvent.returnValues.autoParams);

      // fullfill historical data.
      if (
        submission &&
        !monitoring &&
        nonceValidationStatus == NonceValidationEnum.DUPLICATED_NONCE &&
        sendEvent.blockNumber >= firstMonitoringBlock
      ) {
        const monitoringSentEvent = monitoringSentEventsMap.get(submissionId);
        const monitoringSentEventNonce = parseInt(sendEvent.returnValues.nonce);
        if (!monitoringSentEvent || monitoringSentEventNonce !== nonce) {
          logger.error(`Monitoring event for submissionId: ${submissionId}; with nonce: ${nonce} not found in the map;`);
          return {
            blockToOverwrite: blockNumber, // it would be empty only if incorrect nonce occures in the first event
            status: ProcessNewTransferResultStatusEnum.ERROR,
            submissionId,
            nonce,
          };
        }

        try {
          await this.monitoringSentEventRepository.save({
            submissionId,
            nonce: monitoringSentEventNonce,
            blockNumber: monitoringSentEvent.blockNumber,
            lockedOrMintedAmount: monitoringSentEvent.returnValues.lockedOrMintedAmount,
            totalSupply: monitoringSentEvent.returnValues.totalSupply,
            chainId: chainIdFrom,
          } as MonitoringSentEventEntity);
        } catch (e) {
          logger.error(`Error in saving monitoringSentEvent submissionId: ${submissionId}; nonce: ${nonce}`);
          throw e;
        }
        logger.verbose(`Monitoring event for submissionId: ${submissionId}; with nonce: ${nonce} was added to the db;`);

        continue;
      }

      if (nonceValidationStatus !== NonceValidationEnum.SUCCESS) {
        const message = `Incorrect nonce (${nonceValidationStatus}) for nonce: ${nonce}; max nonce in db: ${maxNonceFromDb}; submissionId: ${submissionId}; blockToOverwrite: ${blockToOverwrite}; submissionWithMaxNonceDb.blockNumber: ${submissionWithMaxNonceDb.blockNumber}`;
        logger.error(message);
        return {
          blockToOverwrite: blockNumber, // it would be empty only if incorrect nonce occures in the first event
          status: ProcessNewTransferResultStatusEnum.ERROR,
          nonceValidationStatus,
          submissionId,
          nonce,
        };
      }

      if (sendEvent.blockNumber >= firstMonitoringBlock) {
        const monitoringSentEvent = monitoringSentEventsMap.get(submissionId);
        const monitoringSentEventNonce = parseInt(sendEvent.returnValues.nonce);
        if (!monitoringSentEvent || monitoringSentEventNonce !== nonce) {
          logger.error(`Monitoring event for submissionId: ${submissionId}; with nonce: ${nonce} not found;`);
          return {
            blockToOverwrite: blockNumber, // it would be empty only if incorrect nonce occures in the first event
            status: ProcessNewTransferResultStatusEnum.ERROR,
            submissionId,
            nonce,
          };
        }

        try {
          await this.monitoringSentEventRepository.save({
            submissionId,
            nonce: monitoringSentEventNonce,
            blockNumber: monitoringSentEvent.blockNumber,
            lockedOrMintedAmount: monitoringSentEvent.returnValues.lockedOrMintedAmount,
            totalSupply: monitoringSentEvent.returnValues.totalSupply,
            chainId: chainIdFrom,
          } as MonitoringSentEventEntity);
        } catch (e) {
          logger.error(`Error in saving monitoringSentEvent submissionId: ${submissionId}; nonce: ${nonce}`);
          throw e;
        }
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
          executionFee: executionFee,
          status: SubmisionStatusEnum.NEW,
          ipfsStatus: UploadStatusEnum.NEW,
          apiStatus: UploadStatusEnum.NEW,
          assetsStatus: SubmisionAssetsStatusEnum.NEW,
          rawEvent: JSON.stringify(sendEvent),
          blockNumber: sendEvent.blockNumber,
          blockTimestamp: blockTimestamp,
          balanceStatus: SubmisionBalanceStatusEnum.RECIEVED,
          nonce,
        } as SubmissionEntity);
        blockToOverwrite = sendEvent.blockNumber;
        this.nonceControllingService.set(chainIdFrom, nonce);
      } catch (e) {
        logger.error(`Error in saving ${submissionId}`);
        throw e;
      }
    }
    return {
      status: ProcessNewTransferResultStatusEnum.SUCCESS,
    };
  }

  async isSubmissionExists(chainIdFrom: number, nonce: number): Promise<boolean> {
    const submission = await this.submissionsRepository.findOne({
      where: {
        chainFrom: chainIdFrom,
        nonce,
      },
    });
    if (submission) {
      return true;
    }
    return false;
  }

  async processValidationNonceError(
    web3: Web3Custom,
    debridgeApiService: DebrdigeApiService,
    chainScanningService: ChainScanningService,
    transferResult: ProcessNewTransferResult,
    chainId: number,
    chainProvider: ChainProvider,
  ) {
    if (transferResult.nonceValidationStatus === NonceValidationEnum.MISSED_NONCE) {
      await debridgeApiService.notifyError(
        `incorrect nonce error (missed_nonce): nonce: ${transferResult.nonce}; submissionId: ${transferResult.submissionId}`,
      );
      chainProvider.setProviderStatus(web3.chainProvider, false);
      return NonceValidationEnum.MISSED_NONCE;
    } else if (transferResult.nonceValidationStatus === NonceValidationEnum.DUPLICATED_NONCE) {
      await debridgeApiService.notifyError(
        `incorrect nonce error (duplicated_nonce): nonce: ${transferResult.nonce}; submissionId: ${transferResult.submissionId}`,
      );
      chainScanningService.pause(chainId);
      return NonceValidationEnum.DUPLICATED_NONCE;
    }
  }

  /**
   * Validate nonce
   * @param nonceDb
   * @param nonce
   * @param nonceExists
   */
  getNonceStatus(nonceDb: number, nonce: number, nonceExists: boolean): NonceValidationEnum {
    if (nonceExists) {
      return NonceValidationEnum.DUPLICATED_NONCE;
    } else if (!nonceExists && nonce <= nonceDb) {
      return NonceValidationEnum.SUCCESS;
    } else if ((nonceDb === undefined && nonce !== 0) || (nonceDb != undefined && nonce !== nonceDb + 1)) {
      // (nonceDb === undefined && nonce !== 0) may occur in empty db
      return NonceValidationEnum.MISSED_NONCE;
    }
    return NonceValidationEnum.SUCCESS;
  }

  async getEvents(contract, eventType: 'Sent' | 'MonitoringSendEvent', fromBlock: number, toBlock) {
    if (fromBlock >= toBlock) return;

    /* get events */
    return await contract.getPastEvents(eventType, { fromBlock, toBlock });
  }
  getExecutionFee(autoParams: string): string {
    if (!autoParams || autoParams.length < 130) {
      return '0';
    }
    const executionFeeDirty = '0x' + autoParams.slice(66, 130);
    const executionFee = new BigNumber(executionFeeDirty);

    return executionFee.toString();
  }
}
