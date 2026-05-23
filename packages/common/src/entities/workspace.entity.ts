import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { RepositoryEntity } from './repository.entity';
import { UserEntity } from './user.entity';

@Entity('workspaces')
export class WorkspaceEntity {
  @PrimaryGeneratedColumn('uuid')
  workspaceId!: string;

  @Column({ nullable: true })
  userId?: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @Column()
  name!: string;

  @Column()
  path!: string;

  @Column({ default: 'filesystem' })
  source!: string;

  @Column({ nullable: true })
  repoId?: string;

  @Column({ type: 'jsonb', nullable: true })
  settings?: Record<string, unknown>;

  @OneToMany(() => RepositoryEntity, (repo) => repo.workspace)
  repos!: RepositoryEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
