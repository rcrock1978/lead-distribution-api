-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `forms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(50) NOT NULL,
    `singleton` BOOLEAN NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `forms_slug_key`(`slug`),
    UNIQUE INDEX `forms_singleton_key`(`singleton`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `distributions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `formId` INTEGER NOT NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Manila',
    `singleton` BOOLEAN NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `distributions_formId_key`(`formId`),
    UNIQUE INDEX `distributions_singleton_key`(`singleton`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brokers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `dailyCap` INTEGER NOT NULL DEFAULT 0,
    `timezone` VARCHAR(64) NOT NULL,
    `openingTime` VARCHAR(5) NOT NULL,
    `closingTime` VARCHAR(5) NOT NULL,
    `workingDays` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `distribution_brokers` (
    `distributionId` INTEGER NOT NULL,
    `brokerId` INTEGER NOT NULL,
    `percentage` DECIMAL(5, 2) NOT NULL,
    `isActiveInDistribution` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`distributionId`, `brokerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `formId` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `ipAddress` VARCHAR(45) NOT NULL,
    `status` ENUM('UNSENT', 'SENT', 'DUPLICATE', 'FAILED') NOT NULL DEFAULT 'UNSENT',
    `brokerId` INTEGER NULL,
    `assignedAt` DATETIME(3) NULL,
    `assignmentType` ENUM('AUTO', 'MANUAL') NULL,
    `failureReason` VARCHAR(255) NULL,
    `decisionTrace` JSON NOT NULL,
    `traceId` CHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leads_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `leads_brokerId_assignedAt_idx`(`brokerId`, `assignedAt`),
    INDEX `leads_traceId_idx`(`traceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assigned_emails` (
    `email` VARCHAR(255) NOT NULL,
    `brokerId` INTEGER NOT NULL,
    `leadId` INTEGER NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `assigned_emails_leadId_key`(`leadId`),
    PRIMARY KEY (`email`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `broker_daily_counters` (
    `brokerId` INTEGER NOT NULL,
    `localDate` DATE NOT NULL,
    `sentCount` INTEGER NOT NULL DEFAULT 0,
    `capAtTime` INTEGER NOT NULL,

    PRIMARY KEY (`brokerId`, `localDate`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outbox` (
    `id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `aggregateType` VARCHAR(32) NOT NULL,
    `aggregateId` VARCHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `traceId` CHAR(32) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimedAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `outbox_status_availableAt_idx`(`status`, `availableAt`),
    INDEX `outbox_aggregateType_aggregateId_idx`(`aggregateType`, `aggregateId`),
    INDEX `outbox_traceId_idx`(`traceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `worker_heartbeats` (
    `workerId` VARCHAR(64) NOT NULL,
    `lastBeatAt` DATETIME(3) NOT NULL,
    `processedTotal` INTEGER NOT NULL DEFAULT 0,
    `version` VARCHAR(32) NOT NULL,

    PRIMARY KEY (`workerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `config_versions` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `distributions` ADD CONSTRAINT `distributions_formId_fkey` FOREIGN KEY (`formId`) REFERENCES `forms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `distribution_brokers` ADD CONSTRAINT `distribution_brokers_distributionId_fkey` FOREIGN KEY (`distributionId`) REFERENCES `distributions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `distribution_brokers` ADD CONSTRAINT `distribution_brokers_brokerId_fkey` FOREIGN KEY (`brokerId`) REFERENCES `brokers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_formId_fkey` FOREIGN KEY (`formId`) REFERENCES `forms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_brokerId_fkey` FOREIGN KEY (`brokerId`) REFERENCES `brokers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assigned_emails` ADD CONSTRAINT `assigned_emails_brokerId_fkey` FOREIGN KEY (`brokerId`) REFERENCES `brokers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assigned_emails` ADD CONSTRAINT `assigned_emails_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `broker_daily_counters` ADD CONSTRAINT `broker_daily_counters_brokerId_fkey` FOREIGN KEY (`brokerId`) REFERENCES `brokers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

