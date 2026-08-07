import { Test, TestingModule } from '@nestjs/testing';
import { FormDraftController } from './form-draft.controller';
import { FormDraftService } from './form-draft.service';

describe('FormDraftController', () => {
  let controller: FormDraftController;
  let service: any;

  beforeEach(async () => {
    service = {
      saveDraft: jest.fn(),
      getDraft: jest.fn(),
      listDrafts: jest.fn(),
      deleteDraft: jest.fn(),
      tryMaterialize: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FormDraftController],
      providers: [{ provide: FormDraftService, useValue: service }],
    }).compile();

    controller = module.get<FormDraftController>(FormDraftController);
  });

  it('should call saveDraft with dto and username', async () => {
    service.saveDraft.mockResolvedValue({ draftId: 'draft-1' });
    const req = { user: { username: 'admin' } };
    const res = await controller.saveDraft({ formType: 'TEAM', payload: {} }, req);
    expect(res).toEqual({ draftId: 'draft-1' });
    expect(service.saveDraft).toHaveBeenCalledWith({ formType: 'TEAM', payload: {} }, 'admin');
  });

  it('should call tryMaterialize with draft id and username', async () => {
    service.tryMaterialize.mockResolvedValue({ success: true, officialRecordId: 'team-1' });
    const req = { user: { username: 'admin' } };
    const res = await controller.materializeDraft('draft-1', req);
    expect(res).toEqual({ success: true, officialRecordId: 'team-1' });
    expect(service.tryMaterialize).toHaveBeenCalledWith('draft-1', 'admin');
  });
});
