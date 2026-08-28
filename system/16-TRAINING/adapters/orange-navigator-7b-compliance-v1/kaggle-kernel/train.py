import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# Kaggle may assign a Pascal P100 (sm_60) or a newer T4. Its rolling base
# image can carry a PyTorch wheel compiled for sm_70+, which fails before the
# first training step on P100. Pin the last known compatible CUDA 12.1 wheel
# before importing torch so the private job is portable across both pools.
subprocess.check_call([
    sys.executable, '-m', 'pip', 'install', '-q', '--upgrade', '--force-reinstall',
    'torch==2.5.1', '--index-url', 'https://download.pytorch.org/whl/cu121'
])
subprocess.check_call([
    sys.executable, '-m', 'pip', 'install', '-q',
    'transformers>=4.51,<5', 'peft>=0.17,<1', 'trl>=0.19,<1',
    'datasets>=3.6,<5', 'accelerate>=1.6,<2', 'bitsandbytes>=0.46,<1'
])

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

BASE = 'Qwen/Qwen2.5-Coder-7B-Instruct'
DATA_ROOT = Path('/kaggle/input/orange-navigator-7b-compliance-v1')
OUT = Path('/kaggle/working/orange-navigator-7b-compliance-v1')
OUT.mkdir(parents=True, exist_ok=True)

def render(example, tokenizer):
    return {'text': tokenizer.apply_chat_template(example['messages'], tokenize=False, add_generation_prompt=False)}

tokenizer = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.float16)
model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=quant, device_map='auto', dtype=torch.float16, trust_remote_code=True)
model.config.use_cache = False
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

files = {'train': str(DATA_ROOT / 'train.jsonl'), 'validation': str(DATA_ROOT / 'val.jsonl')}
dataset = load_dataset('json', data_files=files)
dataset = dataset.map(lambda row: render(row, tokenizer), remove_columns=dataset['train'].column_names)

peft = LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, bias='none', task_type='CAUSAL_LM',
    target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
)
args = SFTConfig(
    output_dir=str(OUT), dataset_text_field='text', max_length=1024,
    num_train_epochs=1, per_device_train_batch_size=1, per_device_eval_batch_size=1,
    gradient_accumulation_steps=8, learning_rate=1.5e-4, warmup_ratio=0.05,
    lr_scheduler_type='cosine', logging_steps=10, eval_strategy='steps', eval_steps=50,
    save_strategy='steps', save_steps=50, save_total_limit=2, report_to='none',
    fp16=True, bf16=False, gradient_checkpointing=True, packing=False, seed=3407,
)
trainer = SFTTrainer(model=model, processing_class=tokenizer, train_dataset=dataset['train'], eval_dataset=dataset['validation'], peft_config=peft, args=args)
result = trainer.train()
trainer.save_model(str(OUT / 'adapter'))
tokenizer.save_pretrained(str(OUT / 'adapter'))

weights = OUT / 'adapter' / 'adapter_model.safetensors'
receipt = {
    'schema': 'orange.training.receipt.v1',
    'status': 'TRAINED',
    'base_model': BASE,
    'adapter': 'orange-navigator-7b-compliance-v1',
    'train_rows': len(dataset['train']),
    'val_rows': len(dataset['validation']),
    'global_step': trainer.state.global_step,
    'train_loss': result.metrics.get('train_loss'),
    'adapter_sha256': hashlib.sha256(weights.read_bytes()).hexdigest(),
    'adapter_bytes': weights.stat().st_size,
    'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}
(OUT / 'training-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
