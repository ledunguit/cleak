import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptedColumn } from './encrypted-column';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  userId!: string;

  @Column({ unique: true })
  githubUserId!: number;

  @Column()
  login!: string;

  @Column({ nullable: true })
  name?: string;

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  avatarUrl?: string;

  @Column({ transformer: encryptedColumn })
  accessToken!: string;

  @Column({ nullable: true, transformer: encryptedColumn })
  refreshToken?: string;

  @Column({ nullable: true })
  tokenExpiresAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
