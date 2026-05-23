import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  @Column()
  accessToken!: string;

  @Column({ nullable: true })
  refreshToken?: string;

  @Column({ nullable: true })
  tokenExpiresAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
